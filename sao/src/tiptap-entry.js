import { Editor, InputRule, Node, renderNestedMarkdownContent } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { CodeBlockLowlight } from '@tiptap/extension-code-block-lowlight';
import { createLowlight } from 'lowlight';
import python from 'highlight.js/lib/languages/python';
import javascript from 'highlight.js/lib/languages/javascript';
import sql from 'highlight.js/lib/languages/sql';
import xml from 'highlight.js/lib/languages/xml';

const lowlight = createLowlight();
lowlight.register('python', python);
lowlight.register('javascript', javascript);
lowlight.register('sql', sql);
lowlight.register('xml', xml);
import { Markdown } from '@tiptap/markdown';
import { history } from '@tiptap/pm/history';
import { Link } from '@tiptap/extension-link';
import { Table } from '@tiptap/extension-table';
import { TableRow } from '@tiptap/extension-table-row';
import { TableCell } from '@tiptap/extension-table-cell';
import { TableHeader } from '@tiptap/extension-table-header';
import { TaskList } from '@tiptap/extension-task-list';
import { TaskItem } from '@tiptap/extension-task-item';
import { Mention } from '@tiptap/extension-mention';

const History = history;

// Party mentions are written `[@Name](party:<id>)`, the format of the portal
// editor: the reading, the escaping and the trigger rules below mirror it so
// a text survives a round trip between the two clients.
const PARTY_MENTION_RE = /^\[@((?:\\[^\n]|[^\\\]\n])*)\]\(party:([1-9]\d*)\)/;
const MAX_PARTY_ID = 2147483647;
const LEAF_PLACEHOLDER = '￼';

const partyIdFrom = (value) => {
    const id = value === null || value === undefined ? '' : String(value);
    return /^[1-9]\d*$/.test(id) && Number(id) <= MAX_PARTY_ID ? id : null;
};

const escapePartyLabel = (name) =>
    name.replace(/[\r\n]+/g, ' ').replace(/([\\*`~+[\]|])/g, '\\$1');

const unescapePartyLabel = (label) => label.replace(/\\([^\n])/g, '$1');

const isInMarkdownCodeContext = (before) => {
    const lines = before.split('\n');
    const current = lines[lines.length - 1] || '';
    const fences = lines.slice(0, -1).filter(line => /^\s*```/.test(line)).length;
    if (fences % 2 === 1) {
        return true;
    }
    return (current.match(/`/g) || []).length % 2 === 1;
};

const matchPartyTrigger = (before) => {
    if (isInMarkdownCodeContext(before)) {
        return null;
    }
    const from = before.lastIndexOf('@');
    if (from < 0 || (from > 0 && !/[\s([>]/.test(before[from - 1] || ''))) {
        return null;
    }
    const query = before.slice(from + 1);
    if (query.length > 80 || /[^\p{L}\p{M}\p{N} '’-]/u.test(query)) {
        return null;
    }
    // A link label or destination is another inline construct, not a mention
    const prefix = before.slice(0, from);
    if (/\[[^\]\n]*$/.test(prefix) || /\]\([^)\n]*$/.test(prefix)) {
        return null;
    }
    return { from, query };
};

const findPartyMentionMatch = ({ $position }) => {
    if (!$position.parent.isTextblock) {
        return null;
    }
    // One character per inline leaf keeps string offsets and positions 1:1
    const before = $position.parent.textBetween(
        0, $position.parentOffset, undefined, LEAF_PLACEHOLDER);
    const match = matchPartyTrigger(before);
    if (!match) {
        return null;
    }
    const start = $position.start();
    return {
        range: { from: start + match.from, to: $position.pos },
        query: match.query,
        text: before.slice(match.from),
    };
};

const allowPartyMention = ({ state, range }) => {
    const $from = state.doc.resolve(range.from);
    if ($from.parent.type.spec.code) {
        return false;
    }
    const excluded = (mark) => mark.type.spec.code || mark.type.name === 'link';
    if (state.selection.$from.marks().some(excluded)) {
        return false;
    }
    let marked = false;
    state.doc.nodesBetween(range.from, range.to, (node) => {
        if (node.isText && node.marks.some(excluded)) {
            marked = true;
        }
    });
    if (marked) {
        return false;
    }
    return Boolean($from.parent.type.contentMatch.matchType(
        state.schema.nodes.mention));
};

const foldName = (text) =>
    text.normalize('NFD').replace(/\p{M}/gu, '').toLocaleLowerCase();

const filterParties = (parties, query) => {
    const needle = foldName(query.trim());
    return parties
        .filter(party => foldName(party.label).includes(needle))
        .sort((a, b) =>
            Number(foldName(b.label).startsWith(needle)) -
                Number(foldName(a.label).startsWith(needle)) ||
            a.label.localeCompare(b.label) ||
            Number(a.id) - Number(b.id));
};

const PartyMention = Mention.extend({
    markdownTokenName: 'partyMention',

    markdownTokenizer: {
        name: 'partyMention',
        level: 'inline',
        start: (src) => src.indexOf('[@'),
        tokenize: (src) => {
            const match = PARTY_MENTION_RE.exec(src);
            if (!match || !partyIdFrom(match[2])) {
                return undefined;
            }
            return {
                type: 'partyMention',
                raw: match[0],
                id: match[2],
                label: unescapePartyLabel(match[1]),
            };
        },
    },

    parseMarkdown(token, helpers) {
        return helpers.createNode('mention', { id: token.id, label: token.label });
    },

    renderMarkdown(node) {
        const attrs = node.attrs || {};
        const label = escapePartyLabel(String(attrs.label || ''));
        const id = partyIdFrom(attrs.id);
        return id ? `[@${label}](party:${id})` : `@${label}`;
    },
});

const MarkdownTable = Table.extend({
    markdownTokenName: 'table',

    parseMarkdown(token, helpers) {
        const headerRow = helpers.createNode('tableRow', {},
            token.header.map(cell =>
                helpers.createNode('tableHeader', {}, [
                    helpers.createNode('paragraph', {}, helpers.parseInline(cell.tokens)),
                ])
            )
        );
        const bodyRows = token.rows.map(row =>
            helpers.createNode('tableRow', {},
                row.map(cell =>
                    helpers.createNode('tableCell', {}, [
                        helpers.createNode('paragraph', {}, helpers.parseInline(cell.tokens)),
                    ])
                )
            )
        );
        return helpers.createNode('table', {}, [headerRow, ...bodyRows]);
    },

    renderMarkdown(node, helpers) {
        const rows = node.content || [];
        const lines = [];
        for (let i = 0; i < rows.length; i++) {
            lines.push(helpers.renderChild(rows[i], i));
            if (i === 0) {
                const cols = (rows[i].content || []).length;
                lines.push('| ' + Array(cols).fill('---').join(' | ') + ' |');
            }
        }
        return lines.join('\n');
    },
});

const MarkdownTableRow = TableRow.extend({
    renderMarkdown(node, helpers) {
        const cells = node.content || [];
        const parts = [];
        for (let i = 0; i < cells.length; i++) {
            parts.push(helpers.renderChild(cells[i], i).trim());
        }
        return '| ' + parts.join(' | ') + ' |';
    },
});

const MarkdownTableCell = TableCell.extend({
    renderMarkdown(node, helpers) {
        return helpers.renderChildren(node.content).trim();
    },
});

const MarkdownTableHeader = TableHeader.extend({
    renderMarkdown(node, helpers) {
        return helpers.renderChildren(node.content).trim();
    },
});

const MarkdownTaskList = TaskList.extend({
    markdownTokenName: 'taskList',

    parseMarkdown(token, helpers) {
        return helpers.createNode(
            'taskList',
            {},
            token.items.map(item => {
                const content = [
                    helpers.createNode('paragraph', {}, helpers.parseInline(item.tokens)),
                ];
                if (item.nestedTokens && item.nestedTokens.length > 0) {
                    content.push(...helpers.parseChildren(item.nestedTokens));
                }
                return helpers.createNode('taskItem', { checked: item.checked || false }, content);
            })
        );
    },

    renderMarkdown(node, helpers) {
        return helpers.renderChildren(node.content, '\n');
    },
});

const MarkdownTaskItem = TaskItem.extend({
    renderMarkdown(node, helpers) {
        const checked = node.attrs && node.attrs.checked;
        const prefix = checked ? '- [x] ' : '- [ ] ';
        return renderNestedMarkdownContent(node, helpers, prefix);
    },
});

const LinkWithInputRule = Link.extend({
    addInputRules() {
        const type = this.type;
        return [
            ...(this.parent?.() ?? []),
            new InputRule({
                find: /\[([^\]]+)\]\(([^)]+)\)$/,
                handler: ({ state, range, match }) => {
                    const { tr } = state;
                    tr.replaceWith(
                        range.from, range.to,
                        state.schema.text(match[1], [type.create({ href: match[2] })])
                    );
                    tr.removeStoredMark(type);
                },
            }),
        ];
    },
});

export {
    Editor,
    Node,
    StarterKit,
    Markdown,
    CodeBlockLowlight,
    lowlight,
    LinkWithInputRule as Link,
    MarkdownTable,
    MarkdownTableRow,
    MarkdownTableCell,
    MarkdownTableHeader,
    MarkdownTaskList,
    MarkdownTaskItem,
    History,
    PartyMention,
    findPartyMentionMatch,
    allowPartyMention,
    filterParties,
};

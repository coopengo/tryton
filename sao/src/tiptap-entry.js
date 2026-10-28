import {
    Editor, InputRule, Node, mergeAttributes, renderNestedMarkdownContent,
} from '@tiptap/core';
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
import { PluginKey } from '@tiptap/pm/state';
import { Suggestion } from '@tiptap/suggestion';

const History = history;

// A reference to a Tryton record is written `[Label](tryton:<model>:<id>)`,
// a mention being a reference whose label starts with "@". The reading, the
// escaping and the trigger rules below mirror the server reader
// (coog_core/markdown_reference.py) so a text survives a round trip.
const REFERENCE_RE = /^\[((?:\\[^\n]|[^\\\]\n])+)\]\(tryton:([a-z_][a-z0-9_]*(?:[.-][a-z0-9_]+)*):([1-9]\d*)\)/;
const MODEL_RE = /^[a-z_][a-z0-9_]*(?:[.-][a-z0-9_]+)*$/;
const MAX_RECORD_ID = 2147483647;
const MENTION_PREFIX = '@';
const LEAF_PLACEHOLDER = '￼';

const recordIdFrom = (value) => {
    const id = value === null || value === undefined ? '' : String(value);
    return /^[1-9]\d*$/.test(id) && Number(id) <= MAX_RECORD_ID ? id : null;
};

// A leading "@" is escaped too: only a mention starts with one
const escapeReferenceLabel = (label) =>
    label.replace(/[\r\n]+/g, ' ').replace(/([\\*`~+[\]|])/g, '\\$1')
        .replace(/^@/, '\\@');

const unescapeReferenceLabel = (label) =>
    label.replace(/\\([!-/:-@[-`{-~])/g, '$1');

const isInMarkdownCodeContext = (before) => {
    const lines = before.split('\n');
    const current = lines[lines.length - 1] || '';
    const fences = lines.slice(0, -1).filter(line => /^\s*```/.test(line)).length;
    if (fences % 2 === 1) {
        return true;
    }
    return (current.match(/`/g) || []).length % 2 === 1;
};

const matchTrigger = (before, char) => {
    if (isInMarkdownCodeContext(before)) {
        return null;
    }
    const from = before.lastIndexOf(char);
    if (from < 0 || (from > 0 && !/[\s([>]/.test(before[from - 1] || ''))) {
        return null;
    }
    const query = before.slice(from + char.length);
    if (query.length > 80 || /[^\p{L}\p{M}\p{N} '’-]/u.test(query)) {
        return null;
    }
    // A link label or destination is another inline construct
    const prefix = before.slice(0, from);
    if (/\[[^\]\n]*$/.test(prefix) || /\]\([^)\n]*$/.test(prefix)) {
        return null;
    }
    return { from, query };
};

const findTriggerMatch = ({ char, $position }) => {
    if (!$position.parent.isTextblock) {
        return null;
    }
    // One character per inline leaf keeps string offsets and positions 1:1
    const before = $position.parent.textBetween(
        0, $position.parentOffset, undefined, LEAF_PLACEHOLDER);
    const match = matchTrigger(before, char);
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

const allowReference = ({ state, range }) => {
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
        state.schema.nodes.trytonReference));
};

const referenceText = (node) =>
    (node.attrs.mention ? MENTION_PREFIX : '') + (node.attrs.label || '');

const insertReference = ({ editor, range, props }) => {
    // Swallow the space that follows, as one is inserted after the reference
    const nodeAfter = editor.view.state.selection.$to.nodeAfter;
    if (nodeAfter && nodeAfter.text && nodeAfter.text.startsWith(' ')) {
        range.to += 1;
    }
    editor.chain().focus().insertContentAt(range, [
        {
            type: 'trytonReference',
            attrs: {
                model: props.model,
                id: String(props.id),
                label: props.label,
                mention: Boolean(props.mention),
            },
        },
        { type: 'text', text: ' ' },
    ]).run();
};

// Options:
// - renderHTML({node, HTMLAttributes}): the DOM of a reference, a DOM node or
//   a DOMOutputSpec; by default its label in a span
// - suggestions: one @tiptap/suggestion configuration per trigger, at least
//   its char and items; the item chosen is inserted, {model, id, label,
//   mention} being its attributes
const TrytonReference = Node.create({
    name: 'trytonReference',
    group: 'inline',
    inline: true,
    atom: true,
    selectable: false,

    addOptions() {
        return { HTMLAttributes: {}, renderHTML: null, suggestions: [] };
    },

    addAttributes() {
        const dataAttribute = (name) => ({
            default: null,
            parseHTML: element => element.getAttribute(`data-${name}`),
            renderHTML: attributes => (
                attributes[name] ? { [`data-${name}`]: attributes[name] } : {}),
        });
        return {
            model: dataAttribute('model'),
            id: dataAttribute('id'),
            label: dataAttribute('label'),
            mention: {
                default: false,
                parseHTML: element => element.getAttribute('data-mention') === 'true',
                renderHTML: attributes => (
                    attributes.mention ? { 'data-mention': 'true' } : {}),
            },
        };
    },

    parseHTML() {
        return [{ tag: `span[data-type="${this.name}"]` }];
    },

    renderHTML({ node, HTMLAttributes }) {
        const attributes = mergeAttributes(
            { 'data-type': this.name }, this.options.HTMLAttributes, HTMLAttributes);
        if (this.options.renderHTML) {
            return this.options.renderHTML({ node, HTMLAttributes: attributes });
        }
        return ['span', attributes, referenceText(node)];
    },

    renderText({ node }) {
        return referenceText(node);
    },

    markdownTokenName: 'trytonReference',

    markdownTokenizer: {
        name: 'trytonReference',
        level: 'inline',
        start: (src) => src.indexOf('['),
        tokenize: (src) => {
            const match = REFERENCE_RE.exec(src);
            if (!match || !recordIdFrom(match[3])) {
                return undefined;
            }
            const mention = match[1].startsWith(MENTION_PREFIX);
            return {
                type: 'trytonReference',
                raw: match[0],
                model: match[2],
                id: match[3],
                label: unescapeReferenceLabel(
                    mention ? match[1].slice(MENTION_PREFIX.length) : match[1]),
                mention,
            };
        },
    },

    parseMarkdown(token, helpers) {
        return helpers.createNode('trytonReference', {
            model: token.model,
            id: token.id,
            label: token.label,
            mention: token.mention,
        });
    },

    renderMarkdown(node) {
        const attrs = node.attrs || {};
        const id = recordIdFrom(attrs.id);
        const label = escapeReferenceLabel(String(attrs.label || attrs.id || ''));
        const text = (attrs.mention ? MENTION_PREFIX : '') + label;
        if (!id || !MODEL_RE.test(attrs.model || '')) {
            return text;
        }
        return `[${text}](tryton:${attrs.model}:${id})`;
    },

    addProseMirrorPlugins() {
        return this.options.suggestions.map(suggestion => Suggestion({
            editor: this.editor,
            pluginKey: new PluginKey(`${this.name}${suggestion.char}`),
            findSuggestionMatch: findTriggerMatch,
            allow: allowReference,
            command: insertReference,
            ...suggestion,
        }));
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
    TrytonReference,
};

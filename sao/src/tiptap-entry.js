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
import { closeHistory, history } from '@tiptap/pm/history';
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
// a mention being a reference whose label starts with an unescaped ASCII
// punctuation character, its marker: the character of the trigger that
// inserted it, e.g. "@". The reading, the escaping and the trigger rules below
// mirror the server reader (coog_core/markdown_reference.py) so a text
// survives a round trip in any widget, with or without triggers.
const REFERENCE_RE = /^\[((?:\\[^\n]|[^\\\]\n])+)\]\(tryton:([a-z_][a-z0-9_]*(?:[.-][a-z0-9_]+)*):([1-9]\d*)\)/;
const MODEL_RE = /^[a-z_][a-z0-9_]*(?:[.-][a-z0-9_]+)*$/;
const MAX_RECORD_ID = 2147483647;
// An ASCII punctuation character other than the escape: the marker of a
// mention when it opens a label as written, escaped in a plain label
const MENTION_MARKER_RE = /^[!-/:-@[\]-`{-~]/;
const LEAF_PLACEHOLDER = '￼';

const recordIdFrom = (value) => {
    const id = value === null || value === undefined ? '' : String(value);
    return /^[1-9]\d*$/.test(id) && Number(id) <= MAX_RECORD_ID ? id : null;
};

// A leading punctuation character is escaped too: only a mention starts
// with one, its marker
const escapeReferenceLabel = (label) =>
    label.replace(/[\r\n]+/g, ' ').replace(/([\\*`~+[\]|])/g, '\\$1')
        .replace(MENTION_MARKER_RE, '\\$&');

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

// Whether text typed after before is plain text: not code, nor the label or
// destination of a link, which are other inline constructs
const isPlainTextContext = (before) => !isInMarkdownCodeContext(before) &&
    !/\[[^\]\n]*$/.test(before) && !/\]\([^)\n]*$/.test(before);

// What a trigger character or a typed word follows, besides the start of its
// block: a space, an opening bracket or an opening quote
const WORD_OPENERS = '\\s([>"\'«“‘';
const WORD_OPENER_RE = new RegExp(`[${WORD_OPENERS}]`, 'u');
// What ends a typed word: a space or a punctuation character, except those
// joining words in keys, paths and branch names (dash, slash, underscore)
const WORD_END = '(?![-/_])[\\s\\p{P}]';
const WORD_END_RE = new RegExp(`^${WORD_END}$`, 'u');

const matchTrigger = (before, char) => {
    if (isInMarkdownCodeContext(before)) {
        return null;
    }
    const from = before.lastIndexOf(char);
    if (from < 0 || (from > 0 && !WORD_OPENER_RE.test(before[from - 1] || ''))) {
        return null;
    }
    const query = before.slice(from + char.length);
    if (query.length > 80 || /[^\p{L}\p{M}\p{N} '’-]/u.test(query)) {
        return null;
    }
    if (!isPlainTextContext(before.slice(0, from))) {
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

const excludedMark = (mark) => mark.type.spec.code || mark.type.name === 'link';

// Whether the text between from and to may become a reference: plain text
// of a block that holds references
const canHoldReference = (state, from, to) => {
    const $from = state.doc.resolve(from);
    if (!$from.parent.isTextblock || $from.parent.type.spec.code) {
        return false;
    }
    let marked = false;
    state.doc.nodesBetween(from, to, (node) => {
        if (node.isText && node.marks.some(excludedMark)) {
            marked = true;
        }
    });
    if (marked) {
        return false;
    }
    return Boolean($from.parent.type.contentMatch.matchType(
        state.schema.nodes.trytonReference));
};

const allowReference = ({ state, range }) =>
    !state.selection.$from.marks().some(excludedMark) &&
    canHoldReference(state, range.from, range.to);

// A word typed in full that matches pattern, between a WORD_OPENERS character
// (or the start of its block) and a WORD_END one, is given to resolve(word),
// which answers the {model, id, label} of the reference replacing it, or
// nothing. Answered asynchronously: the word is replaced only if it is still
// where it was typed, as an undoable step of its own. A pattern that does not
// compile (as a JavaScript regular expression with the u flag), or matches an
// empty word, gives no rule.
const wordReferenceRule = (editor, { pattern, resolve }) => {
    let find, whole;
    try {
        find = new RegExp(
            `(^|[${WORD_OPENERS}])(?:${pattern})${WORD_END}$`, 'u');
        whole = new RegExp(`^(?:${pattern})$`, 'u');
    } catch (error) {
        return null;
    }
    if (whole.test('')) {
        return null;
    }
    // Whether word is still at from, a whole word followed by its end
    const wordAt = (state, from, to, word) => {
        if (to >= state.doc.content.size) {
            return false;
        }
        const $from = state.doc.resolve(from);
        const offset = $from.parentOffset;
        if (!$from.parent.isTextblock ||
                offset + word.length + 1 > $from.parent.content.size ||
                state.doc.textBetween(from, to) !== word) {
            return false;
        }
        const text = $from.parent.textBetween(
            0, offset + word.length + 1, undefined, LEAF_PLACEHOLDER);
        return (offset === 0 || WORD_OPENER_RE.test(text[offset - 1])) &&
            WORD_END_RE.test(text[offset + word.length] || '') &&
            isPlainTextContext(text.slice(0, offset)) &&
            canHoldReference(state, from, to);
    };
    return new InputRule({
        find,
        handler: ({ state, range, match }) => {
            const from = range.from + match[1].length;
            const word = match[0].slice(match[1].length, -1);
            const to = from + word.length;
            if (!whole.test(word) || !wordAt(state, from, to, word)) {
                return null;
            }
            Promise.resolve(resolve(word)).then((reference) => {
                const current = editor.state;
                if (!reference || editor.isDestroyed ||
                        !wordAt(current, from, to, word)) {
                    return;
                }
                const tr = closeHistory(current.tr).replaceWith(from, to,
                    current.schema.nodes.trytonReference.create({
                        model: reference.model,
                        id: String(reference.id),
                        label: reference.label,
                        mention: null,
                    }));
                editor.view.dispatch(tr);
            }, () => {});
            // The word is typed as is: it is replaced later, if ever
            return null;
        },
    });
};

const referenceText = (node) =>
    (node.attrs.mention || '') + (node.attrs.label || '');

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
                mention: props.mention || null,
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
//   mention} being its attributes, mention the marker of a mention
// - words: the {pattern, resolve} of the words converted when typed, see
//   wordReferenceRule
const TrytonReference = Node.create({
    name: 'trytonReference',
    group: 'inline',
    inline: true,
    atom: true,
    selectable: false,

    addOptions() {
        return {
            HTMLAttributes: {}, renderHTML: null, suggestions: [], words: [],
        };
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
            mention: dataAttribute('mention'),
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
            return {
                type: 'trytonReference',
                raw: match[0],
                model: match[2],
                id: match[3],
                label: match[1],
            };
        },
    },

    parseMarkdown(token, helpers) {
        const marker = MENTION_MARKER_RE.exec(token.label);
        const mention = marker ? marker[0] : null;
        return helpers.createNode('trytonReference', {
            model: token.model,
            id: token.id,
            label: unescapeReferenceLabel(
                mention ? token.label.slice(mention.length) : token.label),
            mention,
        });
    },

    renderMarkdown(node) {
        const attrs = node.attrs || {};
        const id = recordIdFrom(attrs.id);
        const label = escapeReferenceLabel(String(attrs.label || attrs.id || ''));
        const text = (attrs.mention || '') + label;
        if (!id || !MODEL_RE.test(attrs.model || '')) {
            return text;
        }
        return `[${text}](tryton:${attrs.model}:${id})`;
    },

    addInputRules() {
        return this.options.words
            .map((word) => wordReferenceRule(this.editor, word))
            .filter(Boolean);
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

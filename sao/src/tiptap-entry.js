import { Editor, InputRule } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { Markdown } from '@tiptap/markdown';
import { Link } from '@tiptap/extension-link';
import { Table } from '@tiptap/extension-table';
import { TableRow } from '@tiptap/extension-table-row';
import { TableCell } from '@tiptap/extension-table-cell';
import { TableHeader } from '@tiptap/extension-table-header';
import { TaskList } from '@tiptap/extension-task-list';
import { TaskItem } from '@tiptap/extension-task-item';

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
            token.items.map(item =>
                helpers.createNode('taskItem', { checked: item.checked || false }, [
                    helpers.createNode('paragraph', {}, helpers.parseInline(item.tokens)),
                ])
            )
        );
    },

    renderMarkdown(node, helpers) {
        return helpers.renderChildren(node.content, '\n');
    },
});

const MarkdownTaskItem = TaskItem.extend({
    renderMarkdown(node, helpers) {
        const checked = node.attrs && node.attrs.checked;
        return (checked ? '- [x] ' : '- [ ] ') + helpers.renderChildren(node.content).trim();
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
    StarterKit,
    Markdown,
    LinkWithInputRule as Link,
    MarkdownTable,
    MarkdownTableRow,
    MarkdownTableCell,
    MarkdownTableHeader,
    MarkdownTaskList,
    MarkdownTaskItem,
};

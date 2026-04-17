(function() {
    Sao.config.mount_point = '/sao';

    var _md_svg = function(inner) {
        return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"' +
            ' width="16" height="16" fill="none" stroke="currentColor"' +
            ' stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
            inner + '</svg>';
    };
    var MD_ICONS = {
        undo: _md_svg('<path d="M9 14 4 9l5-5"/><path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11"/>'),
        redo: _md_svg('<path d="m15 14 5-5-5-5"/><path d="M20 9H9.5a5.5 5.5 0 0 0 0 11H13"/>'),
        bold: _md_svg('<path d="M14 12a4 4 0 0 0 0-8H6v8"/><path d="M15 20a4 4 0 0 0 0-8H6v8z"/>'),
        italic: _md_svg('<line x1="19" x2="10" y1="4" y2="4"/><line x1="14" x2="5" y1="20" y2="20"/><line x1="15" x2="9" y1="4" y2="20"/>'),
        strike: _md_svg('<path d="M16 4H9a3 3 0 0 0-2.83 4"/><path d="M14 12a4 4 0 0 1 0 8H6"/><line x1="4" x2="20" y1="12" y2="12"/>'),
        code: _md_svg('<polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/>'),
        h1: _md_svg('<path d="M4 12h8"/><path d="M4 18V6"/><path d="M12 18V6"/><path d="m17 12 3-2v8"/>'),
        h2: _md_svg('<path d="M4 12h8"/><path d="M4 18V6"/><path d="M12 18V6"/><path d="M21 18h-4c0-4 4-3 4-6 0-1.5-2-2.5-4-1"/>'),
        h3: _md_svg('<path d="M4 12h8"/><path d="M4 18V6"/><path d="M12 18V6"/><path d="M17.5 10.5c1.7-1 3.5 0 3.5 1.5a2 2 0 0 1-2 2"/><path d="M17 17.5c2 1.5 4 .3 4-1.5a2 2 0 0 0-2-2"/>'),
        bulletList: _md_svg('<line x1="9" x2="20" y1="6" y2="6"/><line x1="9" x2="20" y1="12" y2="12"/><line x1="9" x2="20" y1="18" y2="18"/><line x1="3" x2="3.01" y1="6" y2="6"/><line x1="3" x2="3.01" y1="12" y2="12"/><line x1="3" x2="3.01" y1="18" y2="18"/>'),
        orderedList: _md_svg('<line x1="10" x2="21" y1="6" y2="6"/><line x1="10" x2="21" y1="12" y2="12"/><line x1="10" x2="21" y1="18" y2="18"/><path d="M4 6h1v4"/><path d="M4 10h2"/><path d="M6 18H4c0-1 2-2 2-3s-1-1.5-2-1"/>'),
        taskList: _md_svg('<path d="m3 17 2 2 4-4"/><path d="m3 7 2 2 4-4"/><line x1="13" x2="21" y1="8" y2="8"/><line x1="13" x2="21" y1="16" y2="16"/>'),
        blockquote: _md_svg('<path d="M3 21c3 0 7-1 7-8V5c0-1.25-.756-2.017-2-2H4c-1.25 0-2 .75-2 1.972V11c0 1.25.75 2 2 2 1 0 1 0 1 1v1c0 1-1 2-2 2s-1 .008-1 1.031V20c0 1 0 1 1 1z"/><path d="M15 21c3 0 7-1 7-8V5c0-1.25-.757-2.017-2-2h-4c-1.25 0-2 .75-2 1.972V11c0 1.25.75 2 2 2h.75c0 2.25.25 4-2.75 4v3c0 1 0 1 1 1z"/>'),
        codeBlock: _md_svg('<rect width="20" height="20" x="2" y="2" rx="2" ry="2"/><path d="m10 10-2 2 2 2"/><path d="m14 14 2-2-2-2"/>'),
        table: _md_svg('<rect width="18" height="18" x="3" y="3" rx="2" ry="2"/><line x1="3" x2="21" y1="9" y2="9"/><line x1="3" x2="21" y1="15" y2="15"/><line x1="9" x2="9" y1="3" y2="21"/><line x1="15" x2="15" y1="3" y2="21"/>'),
        hr: _md_svg('<line x1="5" x2="19" y1="12" y2="12"/>'),
        link: _md_svg('<path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>'),
        source: _md_svg('<path d="M9 9L4 12l5 3"/><path d="M15 9l5 3-5 3"/><line x1="12" x2="12" y1="6" y2="18"/>'),
    };

    Sao.View.Form.Markdown = Sao.class_(Sao.View.Form.Widget, {
        class_: 'form-markdown',
        expand: true,
        init: function(view, attributes) {
            Sao.View.Form.Markdown._super.init.call(this, view, attributes);
            this._show_toolbar = parseInt(attributes.toolbar || '1', 10) !== 0;
            this._source_mode = false;
            this.el = jQuery('<div/>', {
                'class': this.class_ + ' panel panel-default',
            });
            this._toolbar_heading = jQuery('<div/>', {
                'class': 'panel-heading',
            }).appendTo(this.el);
            this.toolbar = this._build_toolbar().appendTo(
                this._toolbar_heading);
            this._table_toolbar = this._build_table_toolbar().appendTo(
                this._toolbar_heading);
            var body = jQuery('<div/>', {
                'class': 'panel-body',
            }).appendTo(this.el);
            this._mount = jQuery('<div/>', {
                'class': 'markdown-editor mousetrap',
            }).appendTo(body);
            this._source_textarea = jQuery('<textarea/>', {
                'class': 'markdown-source',
            }).appendTo(body).hide()
                .on('input', () => {
                    this.send_modified();
                    this._resize_source_textarea();
                })
                .on('blur', () => {
                    Sao.View.Form.Markdown._super.focus_out.call(this);
                });
            this._editor = new Tiptap.Editor({
                element: this._mount[0],
                extensions: [
                    Tiptap.StarterKit.configure({codeBlock: false, link: false}),
                    Tiptap.Markdown,
                    Tiptap.CodeBlockLowlight.configure({lowlight: Tiptap.lowlight}),
                    Tiptap.Link.configure({openOnClick: false}),
                    Tiptap.MarkdownTable.configure({resizable: false}),
                    Tiptap.MarkdownTableRow,
                    Tiptap.MarkdownTableCell,
                    Tiptap.MarkdownTableHeader,
                    Tiptap.MarkdownTaskList,
                    Tiptap.MarkdownTaskItem.configure({nested: true}),
                ],
                content: '',
                onUpdate: () => {
                    this.send_modified();
                    this._update_toolbar_state();
                },
                onSelectionUpdate: () => {
                    this._update_toolbar_state();
                },
                onBlur: () => {
                    Sao.View.Form.Markdown._super.focus_out.call(this);
                },
                editorProps: {
                    handleKeyDown: (view, event) => {
                        if (event.ctrlKey && event.shiftKey && event.key === 'V') {
                            event.preventDefault();
                            if (navigator.clipboard && navigator.clipboard.readText) {
                                navigator.clipboard.readText().then(text => {
                                    if (text) {
                                        const { state, dispatch } = view;
                                        dispatch(state.tr.insertText(text));
                                    }
                                }).catch(() => {});
                            }
                            return true;
                        }
                        return false;
                    },
                },
            });
        },
        _build_toolbar: function() {
            var toolbar = jQuery('<div class="md-toolbar"/>');
            this._toolbar_btns = {};

            var add_btn = (key, icon, label, command) => {
                var btn = jQuery('<button/>', {
                    'class': 'md-btn',
                    'type': 'button',
                    'title': label,
                }).html(icon).appendTo(toolbar);
                btn.on('mousedown', (ev) => ev.preventDefault());
                btn.click(() => command(this._editor));
                this._toolbar_btns[key] = btn;
            };

            var add_sep = () => jQuery('<span class="md-sep"/>').appendTo(toolbar);

            add_btn('undo', MD_ICONS.undo, Sao.i18n.gettext("Undo"),
                (e) => e.chain().focus().undo().run());
            add_btn('redo', MD_ICONS.redo, Sao.i18n.gettext("Redo"),
                (e) => e.chain().focus().redo().run());
            add_sep();
            add_btn('bold', MD_ICONS.bold, Sao.i18n.gettext("Bold"),
                (e) => e.chain().focus().toggleBold().run());
            add_btn('italic', MD_ICONS.italic, Sao.i18n.gettext("Italic"),
                (e) => e.chain().focus().toggleItalic().run());
            add_btn('strike', MD_ICONS.strike, Sao.i18n.gettext("Strikethrough"),
                (e) => e.chain().focus().toggleStrike().run());
            add_btn('code', MD_ICONS.code, Sao.i18n.gettext("Inline code"),
                (e) => e.chain().focus().toggleCode().run());
            add_sep();
            add_btn('h1', MD_ICONS.h1, Sao.i18n.gettext("Heading 1"),
                (e) => e.chain().focus().toggleHeading({level: 1}).run());
            add_btn('h2', MD_ICONS.h2, Sao.i18n.gettext("Heading 2"),
                (e) => e.chain().focus().toggleHeading({level: 2}).run());
            add_btn('h3', MD_ICONS.h3, Sao.i18n.gettext("Heading 3"),
                (e) => e.chain().focus().toggleHeading({level: 3}).run());
            add_sep();
            add_btn('bulletList', MD_ICONS.bulletList, Sao.i18n.gettext("Bullet list"),
                (e) => e.chain().focus().toggleBulletList().run());
            add_btn('orderedList', MD_ICONS.orderedList, Sao.i18n.gettext("Ordered list"),
                (e) => e.chain().focus().toggleOrderedList().run());
            add_btn('taskList', MD_ICONS.taskList, Sao.i18n.gettext("Task list"),
                (e) => e.chain().focus().toggleTaskList().run());
            add_sep();
            add_btn('blockquote', MD_ICONS.blockquote, Sao.i18n.gettext("Blockquote"),
                (e) => e.chain().focus().toggleBlockquote().run());
            add_btn('codeBlock', MD_ICONS.codeBlock, Sao.i18n.gettext("Code block"),
                (e) => e.chain().focus().toggleCodeBlock().run());
            add_sep();
            add_btn('table', MD_ICONS.table, Sao.i18n.gettext("Insert table"),
                (e) => e.chain().focus().insertTable(
                    {rows: 3, cols: 3, withHeaderRow: true}).run());
            add_btn('hr', MD_ICONS.hr, Sao.i18n.gettext("Horizontal rule"),
                (e) => e.chain().focus().setHorizontalRule().run());
            add_btn('link', MD_ICONS.link, Sao.i18n.gettext("Link"),
                (e) => {
                    if (e.isActive('link')) {
                        e.chain().focus().unsetLink().run();
                        return;
                    }
                    var current = e.getAttributes('link').href || '';
                    var url = window.prompt(
                        Sao.i18n.gettext("Link URL"), current);
                    if (url === null) { return; }
                    if (url === '') {
                        e.chain().focus().unsetLink().run();
                    } else {
                        e.chain().focus().setLink({href: url}).run();
                    }
                });
            add_sep();
            add_btn('source', MD_ICONS.source, Sao.i18n.gettext("Toggle source"),
                () => this._toggle_source());

            return toolbar;
        },
        _build_table_toolbar: function() {
            var toolbar = jQuery('<div class="md-table-toolbar"/>');
            this._table_btns = {};

            var add_btn = (key, label, title, command) => {
                var btn = jQuery('<button/>', {
                    'class': 'md-btn md-table-btn',
                    'type': 'button',
                    'title': title,
                }).text(label).appendTo(toolbar);
                btn.on('mousedown', (ev) => ev.preventDefault());
                btn.click(() => command(this._editor));
                this._table_btns[key] = btn;
            };

            var add_sep = () => jQuery('<span class="md-sep"/>').appendTo(toolbar);

            add_btn('addRowBefore', '+row\u2191', Sao.i18n.gettext("Add row above"),
                (e) => e.chain().focus().addRowBefore().run());
            add_btn('addRowAfter', '+row\u2193', Sao.i18n.gettext("Add row below"),
                (e) => e.chain().focus().addRowAfter().run());
            add_btn('deleteRow', '\u2212row', Sao.i18n.gettext("Delete row"),
                (e) => e.chain().focus().deleteRow().run());
            add_sep();
            add_btn('addColumnBefore', '+col\u2190', Sao.i18n.gettext("Add column before"),
                (e) => e.chain().focus().addColumnBefore().run());
            add_btn('addColumnAfter', '+col\u2192', Sao.i18n.gettext("Add column after"),
                (e) => e.chain().focus().addColumnAfter().run());
            add_btn('deleteColumn', '\u2212col', Sao.i18n.gettext("Delete column"),
                (e) => e.chain().focus().deleteColumn().run());
            add_sep();
            add_btn('deleteTable', '\u00d7table', Sao.i18n.gettext("Delete table"),
                (e) => e.chain().focus().deleteTable().run());

            return toolbar;
        },
        _resize_source_textarea: function() {
            var el = this._source_textarea[0];
            var scrollY = window.scrollY;
            el.style.height = 'auto';
            el.style.height = el.scrollHeight + 'px';
            window.scrollTo(window.scrollX, scrollY);
        },
        _toggle_source: function() {
            this._source_mode = !this._source_mode;
            if (this._source_mode) {
                var editorHeight = this._mount[0].offsetHeight;
                this._source_textarea
                    .val(this._editor.getMarkdown())
                    .css('height', editorHeight + 'px');
                this._mount.hide();
                this._source_textarea.show();
                this._source_textarea[0].focus({preventScroll: true});
                this._table_toolbar.removeClass('is-visible');
                this.toolbar.find('.md-btn').not(this._toolbar_btns.source)
                    .prop('disabled', true);
                this._toolbar_btns.source.addClass('is-active');
            } else {
                var md = this._source_textarea.val();
                this._source_textarea.hide().css('height', '');
                this._mount.show();
                this._editor.commands.setContent(
                    md, {contentType: 'markdown', emitUpdate: false});
                this.send_modified();
                this._toolbar_btns.source.removeClass('is-active');
                this.toolbar.find('.md-btn').prop('disabled', false);
                this._update_toolbar_state();
                this._editor.commands.focus(null, {scrollIntoView: false});
            }
        },
        _update_toolbar_state: function() {
            if (!this._editor || !this._toolbar_btns) {
                return;
            }
            if (this._source_mode) {
                this._table_toolbar.removeClass('is-visible');
                return;
            }
            var e = this._editor;
            var states = {
                bold: e.isActive('bold'),
                italic: e.isActive('italic'),
                strike: e.isActive('strike'),
                code: e.isActive('code'),
                h1: e.isActive('heading', {level: 1}),
                h2: e.isActive('heading', {level: 2}),
                h3: e.isActive('heading', {level: 3}),
                bulletList: e.isActive('bulletList'),
                orderedList: e.isActive('orderedList'),
                taskList: e.isActive('taskList'),
                blockquote: e.isActive('blockquote'),
                codeBlock: e.isActive('codeBlock'),
                link: e.isActive('link'),
            };
            for (var key in states) {
                if (this._toolbar_btns[key]) {
                    this._toolbar_btns[key].toggleClass('is-active', states[key]);
                }
            }
            if (this._toolbar_btns.undo) {
                this._toolbar_btns.undo.prop('disabled', !e.can().undo());
            }
            if (this._toolbar_btns.redo) {
                this._toolbar_btns.redo.prop('disabled', !e.can().redo());
            }
            this._table_toolbar.toggleClass('is-visible', e.isActive('table'));
        },
        display: function() {
            var prm = Sao.View.Form.Markdown._super.display.call(this);
            var value = '';
            var record = this.record;
            if (record) {
                value = record.field_get_client(this.field_name) || '';
            }
            this._editor.commands.setContent(
                value, {contentType: 'markdown', emitUpdate: false});
            if (this._source_mode) {
                this._source_textarea.val(value);
            }
            return prm;
        },
        focus: function() {
            if (this._source_mode) {
                this._source_textarea[0].focus();
            } else {
                this._editor.commands.focus();
            }
        },
        get_value: function() {
            if (this._source_mode) {
                return this._source_textarea.val();
            }
            return this._editor.getMarkdown();
        },
        set_value: function() {
            this.field.set_client(this.record, this.get_value());
        },
        get modified() {
            if (this.record && this.field) {
                return this.field.get_client(this.record) != this.get_value();
            }
            return false;
        },
        set_readonly: function(readonly) {
            Sao.View.Form.Markdown._super.set_readonly.call(this, readonly);
            var record = this.record;
            var disabled = readonly || !record;
            this._editor.setEditable(!disabled);
            this._source_textarea.prop('readonly', disabled);
            this.toolbar.find('button').prop('disabled', disabled);
            this._table_toolbar.find('button').prop('disabled', disabled);
            if (disabled || !this._show_toolbar) {
                this._toolbar_heading.hide();
            } else {
                this._toolbar_heading.show();
                if (this._source_mode) {
                    this.toolbar.find('.md-btn').not(this._toolbar_btns.source)
                        .prop('disabled', true);
                }
            }
        },
    });
    Sao.View.FormXMLViewParser.WIDGETS['markdown'] =
        Sao.View.Form.Markdown;



    Sao.Tab.contextmenu = function(evt) {
        evt.preventDefault();
        evt.stopPropagation();

        let close_tabs = (mode) => {
            return () => {
                let tabs_to_close = [];
                let target_tab = jQuery(evt.currentTarget).closest('li').data('tab');
                let met_target = false;
                for (let tab of Sao.Tab.tabs) {
                    if (tab == target_tab) {
                        met_target = true;
                        continue;
                    }
                    if (met_target && (mode == 'left')) {
                        break;
                    }
                    if ((['left', 'others'].includes(mode)) || met_target) {
                        tabs_to_close.push(tab);
                    }
                }

                let prm = null;
                for (let tab of tabs_to_close) {
                    if (prm) {
                        prm = prm.then(() => tab._close_allowed());
                    } else {
                        prm = tab._close_allowed();
                    }
                }
                if (prm) {
                    prm.then(() => {
                        for (let tab of tabs_to_close) {
                            tab.close();
                        }
                    });
                }
            }
        }

        let actions = {
            close_others: close_tabs('others'),
            close_left: close_tabs('left'),
            close_right: close_tabs('right'),
            duplicate: () => {
                let current = Sao.Tab.tabs.get_current();
                Sao.Tab.create(current.attributes, true).then((t) => t.show());
            },
            in_new_tab: () => {
                window.open(window.location.href, '_blank').focus();
            },
        };

        let tab = Sao.Tab.tabs.get_current();
        let menu = Sao.common.PopupMenu.initialize(evt);
        for (const [action, name] of [
            ['close_others', Sao.i18n.gettext("Close all other tabs")],
            ['close_left', Sao.i18n.gettext("Close tabs to the left")],
            ['close_right', Sao.i18n.gettext("Close tabs to the right")],
            ['duplicate', Sao.i18n.gettext("Duplicate the tab")],
            ['in_new_tab', Sao.i18n.gettext("Open in a new browser tab")],
        ]) {
            let menuitem = jQuery('<li/>', {
                'role': 'presentation',
            }).append(jQuery('<a/>', {
                'role': 'menuitem',
                'href': '#',
                'tabindex': -1
            }).text(name).click(actions[action])
            ).appendTo(menu);

            if (((action == 'duplicate') || (action == 'in_new_tab')) &&
                (tab instanceof Sao.Tab.Wizard)) {
                menuitem.addClass("disabled");
                menuitem.children('a').css('pointer-events', 'none');
            }
        }
    };

    Sao.Tab.closed_tabs = [];
    Sao.Tab.undo_close = function() {
        if (Sao.Tab.closed_tabs.length == 0) {
            return;
        }
        let attributes = Sao.Tab.closed_tabs.pop();
        Sao.Tab.create(attributes, true);
    };

}());

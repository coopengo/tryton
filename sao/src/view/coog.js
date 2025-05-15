(function() {
    'use strict';

    // [Coog] widget Source (engine)
    function TreeElement(){
        this.init = function(parent, element, good_text, lvl){
            if (!element || !element.description)
                return false;

            this.help       = good_text || '';
            this.parent     = parent || null;
            this.element    = element;
            this.title      = element.description;
            this.code       = element.translated + '(' + element.fct_args + ')';
            this.lvl        = lvl;
            this.el         = this.init_tree_element();
            this.childs     = [];
            this.visible    = true;
            this.is_parent  = false;
            this.is_populated = false;

            if (this.parent){
                this.parent.append_children(this);
                var spacer = '';
                while(lvl--)
                    spacer = spacer + '\t';
                this.set_visibility(false);
            }
            return true;
        };
        this.set_visibility = function(visible){
            if (visible){
                this.el.show();
                if (this.is_parent)
                    for (var j in this.childs)
                        this.childs[j].set_visibility(visible);
            } else{
                this.el.hide();
                for (var i in this.childs)
                    this.childs[i].set_visibility(visible);
            }
            this.visible = visible;
        };
        this.set_populated = function () {
            this.is_populated = true;
            if (this.parent && !this.parent.is_populated)
                this.parent.set_populated()
        }
        this.init_tree_element = function(){
            var td, table, tbody, tr, expander, content, text;
            var tr_container, td_container;

            tr_container = jQuery('<tr/>').css({
                'display': 'inline-block',
                'width': '100%'
            });
            td_container = jQuery('<td/>').appendTo(tr_container).css({
                'display': 'inline-block',
                'width': '100%'
            });
            td = jQuery('<td/>').appendTo(td_container);
            td.css('overflow', 'hidden');
            table = jQuery('<table/>').appendTo(td).css('width', '100%');
            tbody = jQuery('<tbody/>').appendTo(table);
            tr = jQuery('<tr/>').appendTo(tbody);
            this.expander = jQuery('<td/>', {
                'class': 'expander'
            }).appendTo(tr);
            this.expander.css({
                'width': parseInt(this.lvl * 30) + 'px',
                'display': 'inline-block'
            });
            content = jQuery('<td/>').appendTo(tr);
            text = jQuery('<p/>', {
                'draggable': 'true',
                'data-toggle': 'tooltip',
                'title': this.help
            }).appendTo(content).text(this.title);

            /*event managment*/
            //!!!> need testing on other browsers
            text[0].addEventListener('dragstart', function(event){
                event.dataTransfer.setData("text", this.code);
            }.bind(this));

            tr_container[0].addEventListener('click', function(event){
                if (this.is_parent)
                    this.set_expander(!this.expanded);
                for (var i in this.childs){
                    this.childs[i].set_visibility(this.expanded);
                }
            }.bind(this));

            return tr_container;
        };
        this.get_element = function(){
            return this.el;
        };
        this.set_expander = function(expanded){
            var icon = '';
            if (expanded)
                icon = 'minus';
            else
                icon = 'plus';

            this.expander.empty();
            var span = jQuery('<span/>', {
                'class': 'glyphicon glyphicon-' + icon
            }).appendTo(this.expander);
            span.html('&nbsp;');
            span.css({
                'float': 'right'
            });
            this.expanded = expanded;
        };
        this.append_children = function(children){
            this.childs.push(children);
            if (!this.is_parent){
                this.set_expander(false);
                this.is_parent = true;
            }
        };
    }

    // [Coog] widget Source (engine)
    Sao.View.Form.Source = Sao.class_(Sao.View.Form.Widget, {
        class_: 'form-source',
        init: function(view, attributes) {
            Sao.View.Form.Source._super.init.call(this, view, attributes);
            this.el = jQuery('<div/>', {
                'class': this.class_
            });
            this.tree_data_field = attributes.context_tree || null;

            this.init_tree();
            this.tree_data = [];
            this.tree_elements = [];
            this.value = '';
            this.json_data = '';
            this.prev_record = undefined;
            this.init_editor();
            this.completionActive = true;
            this.auto_complete_builtins = ["break", "continue", "def", "elif",
                "else", "for", "if", "lambda", "pass", "raise", "return",
                "while", "with", "in", "False", "True", "abs", "all", "any",
                "bool", "bytearray", "chr", "dict", "divmod", "enumerate",
                "filter", "float", "format", "frozenset", "hash", "hex", "list",
                "map", "max", "min", "next", "oct", "ord", "pow", "range",
                "reversed", "set", "slice", "sorted", "str", "sum", "tuple",
                "type", "zip", "Decimal", "break", "continue", "def", "elif"
                ];
        },
        init_editor: function(){
            var button_apply_command = function(evt) {
                var cmDoc = this.codeMirror.getDoc();
                switch (evt.data) {
                    case 'undo':
                        cmDoc.undo();
                        break;
                    case 'redo':
                        cmDoc.redo();
                        break;
                    case 'check':
                        this.codeMirror.performLint();
                        break;
                    case 'toggle_menu':
                        this.toggle_menu();
                        break;;
                }
            }.bind(this);

            var add_buttons = function(buttons) {
                var i, properties, button;
                var group = jQuery('<div/>', {
                    'class': 'btn-group',
                    'role': 'group'
                }).appendTo(this.toolbar);
                for (i in buttons) {
                    properties = buttons[i];
                    button = jQuery('<button/>', {
                        'class': 'btn btn-default',
                        'type': 'button'
                    }).append(jQuery('<span/>', {
                        'class': 'glyphicon glyphicon-' + properties.icon
                    })).appendTo(group);
                    button.click(properties.command, button_apply_command);
                }
            }.bind(this);
            this.sc_editor = jQuery('<div/>', {
                'class': 'panel panel-default'
            }).appendTo(this.el).css('padding', '0');

            this.toolbar = jQuery('<div/>', {
                'class': 'btn-toolbar',
                'role': 'toolbar'
            }).appendTo(jQuery('<div/>', {
                'class': 'panel-heading'
            }).appendTo(this.sc_editor));
            this.toolbar.css({
                width: '100%',
            });

            add_buttons([
                    {
                        'icon': 'menu-hamburger',
                        'command': 'toggle_menu'
                    }, {
                        'icon': 'arrow-left',
                        'command': 'undo'
                    }, {
                        'icon': 'arrow-right',
                        'command': 'redo'
                    }, {
                        'icon': 'ok',
                        'command': 'check'
                    }]);

            var input = jQuery('<textarea/>', {
            }).appendTo(jQuery('<div/>', {
                'class': 'panel-body'
            }).appendTo(this.sc_editor).css('min-height', '490px'));
            this.codeMirror = CodeMirror.fromTextArea(input[0], {
                mode: {
                    name: 'python',
                    version: 3,
                    singleLineStringErrors: false
                },
                lineNumbers: true,
                indentUnit: 4,
                indentWithTabs: false,
                matchBrackets: true,
                autoRefresh: true,
                gutters: ["CodeMirror-lint-markers"],
                lint: {
                    lintOnChange: true,
                    getAnnotations: this.pythonLinter.bind(this),
                    async: true
                }
            });
            this.codeMirror.on('change', this.send_modified.bind(this));
            this.codeMirror.on('blur', this._focus_out.bind(this));
            // When hint are toggled, autocomplete on input
            this.codeMirror.on('inputRead', this._show_hint.bind(this));
            this.codeMirror.setOption("extraKeys" ,{
                "Alt-R": "replace",
                "Shift-Alt-R": "replaceAll",
                "Ctrl-S": this._save.bind(this),
                "Ctrl-Space": this._enable_hint.bind(this),
            });
        },
        _populate_funcs: function (tree_data, func_list) {
            // Feed hint and lint context with general rule context
            if (!tree_data) { return ;}
            var element;
            for (var cnt in tree_data) {
                element = tree_data[cnt];
                if (!func_list.includes(element.translated))
                    func_list.push(element.translated);
                if (element.children && element.children.length > 0) {
                    this._populate_funcs(element.children, func_list);
                }
            }
        },
        _hint: function(cm) {
            var cursor = this.codeMirror.getCursor();
            var token = this.codeMirror.getTokenAt(cursor);
            var start = token.start;
            var end = token.end;
            var word = token.string;
            // Feed hint context with hardcoded builtins, and variable names in current rule
            var list =  [...this.auto_complete_builtins]
            CodeMirror.runMode(this.codeMirror.getValue(), 'python', function(name, kind) {
                if (['variable', 'keyword'].includes(kind) && name != word)
                    return list.push(name);
              })
            var inner = {
                from: CodeMirror.Pos(cursor.line, start),
                to: CodeMirror.Pos(cursor.line, end),
                list: [...new Set(list)]
            };

            var to_parse = "[]";
            if (this.json_data) { to_parse = this.json_data ;}
            this._populate_funcs(JSON.parse(to_parse), inner.list);
            // Filter context names based on the current word
            inner.list = inner.list.filter(function(fn) {
              return fn.startsWith(word);
            });

            return inner;
        },
        _show_hint: function(editor) {
            if (this.completionActive === true) {
                editor.showHint({
                    hint: this._hint.bind(this),
                    completeSingle: false
                });
            }
        },
        _enable_hint: function(editor, event){
            this.completionActive = this.completionActive ? false : true;
            this._show_hint(editor);
        },
        _save: function() {
            var current_tab = Sao.Tab.tabs.get_current();
            if (current_tab) {
                this._focus_out();
                current_tab.save();
            }
        },
        _focus_out: function() {
            this.send_modified();
            this.focus_out();
        },
        toggle_menu: function() {
            if (this.container.data('collapsed') === true) {
                this.container.data('collapsed', false)
                this.container.css(
                    'width', this.container.data('previous-width'));
                this.container.css('display', 'block');
            } else {
                this.container.data('collapsed', true)
                this.container.data(
                    'previous-width', this.container.css('width'));
                this.container.css('display', 'none');
            }
        },
        init_tree: function() {
            this.container = jQuery('<div/>').appendTo(this.el);
            this.container.css('flex', '1');
            const tree_resizer_obs = new MutationObserver((mutationList) => {
                if (mutationList.length == 0) {
                    return;
                }
                this.container.css('flex', 'unset');
                tree_resizer_obs.disconnect();
            });
            tree_resizer_obs.observe(this.container[0], {
                attributeFilter: ["style"],
                subtree: false,
            });
            this.sc_tree = jQuery('<div/>', {
                'class': 'treeview responsive'
            }).appendTo(this.container).css('padding', '0');

            this.table = jQuery('<table/>', {
                'class': 'tree table table-hover'
            }).appendTo(this.sc_tree);

            // Search header
            this.theader = jQuery('<thead/>', {
                'class': 'form-char xexpand required'
            }).appendTo(this.table);
            this.search_div = jQuery('<div/>', {
                'class': 'input-group input-group-sm input-icon input-icon-secondary',
                'width': '100%'
            }).appendTo(this.theader);
            // Search input (it update tree automatically)
            this.wid_text = jQuery('<input/>', {
                'type': 'text',
                'class': 'form-control input-sm',
                'placeholder': Sao.i18n.gettext('Search'),
            }).appendTo(this.search_div);
            this.wid_text.on('keyup', this.display_tree.bind(this));
            // Search clear button
            this.clear_btn = jQuery('<div/>', {
                'class': 'icon-input icon-secondary',
                'arial-label': Sao.i18n.gettext("Clear"),
                'title': Sao.i18n.gettext("Clear"),
            }).append(jQuery('<span>x</span>', {
                'aria-hidden': true,
            })).appendTo(this.search_div);
            // Make it show like its clickable, and do something when acting upon it
            this.clear_btn.css('cursor', 'pointer');
            this.clear_btn.on('click', this.clear_filter.bind(this));

            // T(h)ree body problem solved
            this.tbody = jQuery('<tbody/>').appendTo(this.table);
            this.tbody.css({
                'display': 'block',
                'height': '490px'
            });
        },
        get modified() {
            if (this.record && this.field) {
                var value = this.get_client_value();
                return value != this.get_value();
            }
            return false;
        },
        get_client_value: function() {
            var field = this.field;
            var record = this.record;
            var value = '';
            if (field) {
                value = field.get_client(record);
            }
            return value;
        },
        get_value: function() {
            return this.codeMirror.getValue();
        },
        display: function(){
            let prm = Sao.View.Form.Source._super.display.call(this);

            var display_code = function(str){
                // Resetting the same value will reset the view at the top,
                // and it serves no purpose anyway
                if (str === this.codeMirror.getValue()) {
                    return
                }
                let prev_position = this.codeMirror.getScrollInfo()
                this.codeMirror.setValue(str);
                this.codeMirror.refresh();
                this.codeMirror.scrollTo(prev_position.left, prev_position.top);
                // We must do this to avoid considering the previously
                // displayed record's algorithm as an history entry for the
                // current one (meaning using "Ctrl+Z" can replace the current
                // algorithm with the previous record's)
                if (this.record !== this.prev_record) {
                    this.prev_record = this.record;
                    this.codeMirror.clearHistory();
                }
            }.bind(this);

            if (!this.field || !this.record) {
                this.codeMirror.setValue('');
                this.clear_tree();
                return prm;
            }

            var value = this.field.get_client(this.record);
            if (value != this.value){
                this.value = value;
                display_code(this.value);
            }

            if (this.tree_data_field){
                if (!this.record)
                    return prm;
                prm = this.record.load(this.tree_data_field).then(this.display_tree());
            }
            return prm;
        },
        create_tree_element: function(parent, element, good_text, iter_lvl){
            var treeElem = new TreeElement();
            if (treeElem.init(parent, element, good_text, iter_lvl)){
                return treeElem;
            }
            return null;
        },
        append_tree_elements: function(tree_elem){
            // Only show element if tree is populated
            if (!tree_elem || !tree_elem.is_populated)
                return;
            tree_elem.get_element().appendTo(this.tbody);
            for (var idx in tree_elem.childs){
                // Recursively append children nodes to the view
                this.append_tree_elements(tree_elem.childs[idx]);
            }
        },
        clear_filter: function(){
            this.wid_text.val('');
            // Pass an "event" as parameter to trigger redraw without filter
            this.display_tree(true);
        },
        display_tree: function(event){
            var tree_data, json_data;
            var filter  = this.wid_text.val();
            json_data = this.record.field_get_client(this.tree_data_field);
            if (json_data){
                // Trigger redraw if tree is updated OR if an event such as filter change is triggered
                if (json_data != this.json_data || event){
                    this.clear_tree();
                    this.json_data = json_data;
                    tree_data = JSON.parse(this.json_data);
                    var filter  = this.wid_text.val() ?
                        this.normalize_string(this.wid_text.val()) : undefined;
                    this.populate_tree(tree_data, filter);
                }
            } else {
                this.tree_data = [];
                this.clear_tree();
            }
        },
        clear_tree: function(){
            this.tbody.empty();
        },
        normalize_string: function(str){
            return str.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
        },
        filter_element: function(element, filter){
            if (!filter || (element.children && element.children.length > 0))
                return true;
            var long_desc = element.long_description ?
                this.normalize_string(element.long_description) : '';
            var description = element.description ?
                this.normalize_string(element.description) : '';
            if (long_desc.includes(filter) || description.includes(filter)){
                return true;
            }
            return false;
        },
        populate_tree: function(tree_data, filter, iter_lvl, parent){
            var element, cnt;
            var desc, param_txt, good_text, new_iter;

            if (!iter_lvl)
                iter_lvl = 1;
            for (cnt in tree_data){
                element = tree_data[cnt];
                desc = element.long_description || '';
                // !!!> change by sao traduction
                if (element.fct_args)
                    param_txt = 'Parameters: ' + element.fct_args;
                else
                    param_txt = 'No Parameters';
                if (desc)
                    good_text = desc + '\n\n' + param_txt;
                else
                    good_text = param_txt;
                // Only treat parent node or filtered elements
                if (this.filter_element(element, filter)) {
                    new_iter = this.create_tree_element(parent, element, good_text, iter_lvl);
                    if (element.children && element.children.length > 0) {
                        // Populate children nodes
                        this.populate_tree(element.children, filter, iter_lvl + 1, new_iter);
                    } else {
                        // Or set parent node as populated (At least one children node is unfiltered)
                        new_iter.set_populated()
                    }
                if (!parent)
                    // If treating root node, start building view tree
                    this.append_tree_elements(new_iter);
                }
            }
        },
        set_value: function(){
            this.field.set_client(this.record, this.codeMirror.getValue());
        },
        set_readonly: function(readonly) {
            if (readonly) {
                this.sc_editor.addClass('readonly');
            } else {
                this.sc_editor.removeClass('readonly');
            }
            this.codeMirror.setOption('readOnly', readonly);
        },
        pythonLinter: function(doc, updateLint, options, editor) {
            var known_funcs = [];
            var linter = new Sao.Model('linter.Linter');
            var code = editor.getValue();

            var to_parse = "[]";
            if (this.json_data) { to_parse = this.json_data ;}
            this._populate_funcs(JSON.parse(to_parse), known_funcs);

            linter.execute('lint', [code, known_funcs]).done(function(errors) {
                var codeMirrorErrors = [];
                for (var idx in errors) {
                    var error = errors[idx];
                    codeMirrorErrors.push({
                        message: error[2],
                        severity: 'error',
                        from: CodeMirror.Pos(error[0] - 1, error[1]),
                        to: CodeMirror.Pos(error[0] - 1, error[1]),
                    });
                }
                updateLint(codeMirrorErrors);
            }.bind(this));
        }
    });

    Sao.View.Form.JSON = Sao.class_(Sao.View.Form.Widget, {
        class_: 'form-json',
        expand: true,
        init: function(view, attributes) {
            Sao.View.Form.JSON._super.init.call(this, view, attributes);
            this.el = jQuery('<div/>', {
                'class': this.class_,
            });
            this.group = jQuery('<div/>', {
                'class': 'input-group',
            }).appendTo(this.el);
            this.input = this.labelled = jQuery('<textarea/>', {
                'class': 'form-control input-sm mousetrap',
                'name': attributes.name,
            }).appendTo(this.group);
        },
        set_readonly: function(readonly) {
            Sao.View.Form.JSON._super.set_readonly.call(this, readonly);
            this.input.prop('readonly', readonly);
        },
        display: function() {
            Sao.View.Form.JSON._super.display.call(this);
            let record = this.record;
            if (record) {
                let value = record.field_get_client(this.field_name);
                value = JSON.stringify(value, null, 2);
                if (this.attributes.yexpand) {
                    this.input.css('height', value.split('\n').length * 2.5 + 2 + "ex");
                }
                this.input.val(value);
            } else {
                this.input.val('');
            }
            return jQuery.when();
        },
    });

    Object.assign(Sao.View.FormXMLViewParser.WIDGETS, {
        'source': Sao.View.Form.Source,
        'json': Sao.View.Form.JSON,
    });

}());

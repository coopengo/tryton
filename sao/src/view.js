/* This file is part of Tryton.  The COPYRIGHT file at the top level of
   this repository contains the full copyright notices and license terms. */
(function() {
    'use strict';

    Sao.View = Sao.class_(Object, {
        view_type: null,
        el: null,
        mnemonic_widget: null,
        view_id: null,
        modified: null,
        editable: null,
        creatable: null,
        children_field: null,
        xml_parser: null,
        init: function(view_id, screen, xml) {
            this.view_id = view_id;
            this.screen = screen;
            this.widgets = {};
            this.state_widgets = [];
            var attributes = xml.children()[0].attributes;
            this.attributes = {};
            for (const attribute of attributes) {
                this.attributes[attribute.name] = attribute.value;
            }
            screen.set_on_write(this.attributes.on_write);

            var field_attrs = {};
            for (var name in this.screen.model.fields) {
                field_attrs[name] = this.screen.model.fields[name].description;
            }
            if (this.xml_parser) {
                new this.xml_parser(
                    this, this.screen.exclude_field, field_attrs)
                    .parse(xml.children()[0]);
            }
            this.reset();
        },
        set_value: function() {
        },
        get record() {
            return this.screen.current_record;
        },
        set record(value) {
            this.screen.current_record = value;
        },
        get group() {
            return this.screen.group;
        },
        get selected_records() {
            return [];
        },
        get_fields: function() {
            return [];
        },
        get_buttons: function() {
            return [];
        },
        reset: function() {
        },
    });

    Sao.View.idpath2path = function(tree, idpath) {
        var path = [];
        var child_path;
        if (!idpath) {
            return [];
        }
        for (var i = 0, len = tree.rows.length; i < len; i++) {
            if (tree.rows[i].record.id == idpath[0]) {
                path.push(i);
                child_path = Sao.View.idpath2path(tree.rows[i],
                        idpath.slice(1, idpath.length));
                path = path.concat(child_path);
                break;
            }
        }
        return path;
    };

    // [Coog specific] multi_mixed_view
    Sao.View.parse = function(screen, view_id, type, xml, children_field, 
                children_definitions) {
        switch (type) {
            case 'tree':
                // [Coog specific] multi_mixed_view
                return new Sao.View.Tree(view_id, screen, xml, children_field,
                    children_definitions);
            case 'form':
                return new Sao.View.Form(view_id, screen, xml);
            case 'graph':
                return new Sao.View.Graph(view_id, screen, xml);
            case 'calendar':
                return new Sao.View.Calendar(view_id, screen, xml);
            case 'list-form':
                return new Sao.View.ListForm(view_id, screen, xml);
        }
    };

    Sao.View.XMLViewParser = Sao.class_(Object, {
        init: function(view, exclude_field, field_attrs) {
            this.view = view;
            this.exclude_field = exclude_field;
            this.field_attrs = field_attrs;
        },
        _node_attributes: function(node) {
            var node_attrs = {};
            for (var attribute of node.attributes) {
                node_attrs[attribute.name] = attribute.value;
            }

            var field = {};
            if (node_attrs.name) {
                field = this.field_attrs[node_attrs.name] || {};
            }

            for (const name of ['readonly', 'homogeneous']) {
                if (node_attrs[name]) {
                    node_attrs[name] = node_attrs[name] == 1;
                }
            }
            for (const name of [
                'yexpand', 'yfill',
                'xexpand', 'xfill',
                'colspan', 'position', 'height', 'width']) {
                if (node_attrs[name]) {
                    node_attrs[name] = Number(node_attrs[name]);
                }
            }
            for (const name of ['xalign', 'yalign']) {
                if (node_attrs[name]) {
                    node_attrs[name] = Number(node_attrs[name]);
                }
            }

            if (!jQuery.isEmptyObject(field)) {
                if (!node_attrs.widget) {
                    node_attrs.widget = field.type;
                }
                if ((node.tagName == 'label') &&
                        (node_attrs.string === undefined)) {
                    node_attrs.string = field.string + Sao.i18n.gettext(':');
                }
                if ((node.tagName == 'field') && (!node_attrs.help)) {
                    node_attrs.help = field.help;
                }
                try {
                    var decoder = new Sao.PYSON.Decoder({}, true);
                    var h = node_attrs.help;
                    if (h) {
                        h = h + '\n\n';
                    }
                    h = h + `${this.view.screen.model_name}::${field.name} `;
                    h = h + `(${field.type}):\n\n`;
                    for (const [key, value] of Object.entries(field)) {
                        if (['on_change', 'on_change_with',
                                'relation_fields', 'help', 'name', 'type',
                                'views', 'selection_change_with']
                                .includes(key)) {
                            continue;
                        }
                        if (key === 'states') {
                            for (var [state, s_value] of Object.entries(
                                    decoder.decode(value))) {
                                var v = Sao.PYSON.toString(s_value);
                                h = h + `states[${state}]: ${s_value}\n`
                            }
                        } else if (['context', 'search_context', 'domain',
                                'search_order', 'datetime_field'
                                ].includes(key)) {
                            var v = Sao.PYSON.toString(decoder.decode(value));
                            if ((v !== '[]') && (v !== '{}') && (v !== 'null')) {
                                h = h + `${key}: ${v}\n`;
                            }
                        } else if ((key === 'selection')
                                && (value.constructor == Array)) {
                            h = h + 'selection:\n';
                            for (const [i, j] of value.slice(0, 10)) {
                                if ((i === null) || (i === '')) {
                                    continue;
                                }
                                h = h + `    ${i}: ${j}\n`;
                            }
                            if (value.length > 10) {
                                var c = value.length - 10;
                                h = h + `    ... ${c} elements omitted\n`;
                            }
                        } else {
                            var v = JSON.stringify(value, null, 4);
                            h = h + `${key}: ${v}\n`;
                        }
                    }
                    node_attrs.developer_help = h;
                } catch (error) {
                    node_attrs.developer_help = '';
                    Sao.Logger.warn("Error creating developer help", error);
                }

                for (const name of [
                    'relation', 'domain', 'selection', 'string', 'states',
                    'relation_field', 'views', 'invisible', 'add_remove',
                    'sort', 'context', 'size', 'filename', 'autocomplete',
                    'translate', 'create', 'delete', 'selection_change_with',
                    'schema_model', 'required', 'help_selection', 'help_field',
                    'order', 'symbol', 'monetary']) {
                    if ((name in field) && (!(name in node_attrs))) {
                        node_attrs[name] = field[name];
                    }
                }
            }
            return node_attrs;
        },
        parse: function(node) {
            if (node.tagName) {
                var attributes = this._node_attributes(node);
                this['_parse_' + node.tagName](node, attributes);
            }
        },
    });
}());

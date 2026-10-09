(function() {
    'use strict';

    Sao.View.Form.JSON = Sao.class_(Sao.View.Form.Widget, {
        class_: 'form-json form-text',
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

    Sao.View.Form.Billboard = Sao.class_(Sao.View.Form.Widget, {
        class_: 'form-billboard',
        init: function(view, attributes) {
            Sao.View.Form.Billboard._super.init.call(this, view, attributes);
            this.el = jQuery('<div/>', {
                'class': this.class_,
            });
            this.el.uniqueId();
            this._charts = [];
        },
        display: function() {
            let prm = Sao.View.Form.Billboard._super.display.call(this);
            if (!this.field || !this.record) {
                return prm;
            }

            let value = this.field.get_client(this.record) || {};
            if (value.charts) {
                this._display_charts(value.charts);
                return prm;
            }
            if (!value.data) {
                return prm;
            }
            if (['pie', 'donut'].includes(value.data.type)) {
                this._set_pie_mode(value);
            }
            this._set_formats(value);
            Object.assign(value, {
                bindto: `#${this.el.attr('id')}`,
            });
            if (value.data && Object.keys(value.data).length != 0) {
                this._set_action(value);
            }
            let bb_node = document.getElementById(this.el.attr('id'));
            if (bb_node && Object.keys(value).length != 0) {
                bb.generate(value);
            }
            return prm;
        },
        // x-sao.ids maps each series to one id list per x index; a pie has a
        // single value per series, so its slice reads the first list.
        _set_action: function(value) {
            let x_sao = structuredClone(value['x-sao']);
            if (!x_sao || !x_sao.action) {
                return;
            }
            let pie = ['pie', 'donut'].includes(value.data.type);
            value.data.onclick = (data) => {
                let ids = (x_sao.ids[data.id] || [])[pie ? 0 : data.index];
                let ctx = Object.assign(
                    {}, this.view.screen.local_context, x_sao.context || {});
                ctx.data_id = data.id;
                delete ctx.active_ids;
                delete ctx.active_id;
                Sao.Action.execute(x_sao.action, {
                    id: ((ids && ids.length > 0) ? ids[0] : null),
                    ids: ids,
                }, ctx, false);
            };
        },
        // A {"charts": [...]} value is drawn as a grid of charts, each one
        // `height` pixels high.
        _display_charts: function(charts) {
            if (this._resize_observer) {
                this._resize_observer.disconnect();
            }
            for (let chart of this._charts) {
                chart.destroy();
            }
            this._charts = [];
            this.el.empty();
            if (!document.getElementById(this.el.attr('id'))) {
                return;
            }
            let grid = jQuery('<div/>', {
                'class': 'form-billboard-grid',
            }).css({
                'display': 'grid',
                'grid-template-columns': 'repeat(auto-fit, minmax(600px, 1fr))',
                'gap': '15px',
            }).appendTo(this.el);
            // All the cells are laid out before any chart measures its own,
            // otherwise auto-fit changes the column count between charts.
            let configs = [];
            for (let chart of charts) {
                if (!chart.data) {
                    continue;
                }
                let node = jQuery('<div/>').css({
                    'height': (this.attributes.height || 320) + 'px',
                    'min-width': 0,
                    'overflow': 'hidden',
                }).appendTo(grid);
                node.uniqueId();
                chart = structuredClone(chart);
                if (['pie', 'donut'].includes(chart.data.type)) {
                    this._set_pie_mode(chart);
                }
                this._set_formats(chart);
                this._focus_on_hover(chart);
                this._set_action(chart);
                chart.bindto = `#${node.attr('id')}`;
                configs.push(chart);
            }
            // billboard caches its text measurements, which are all zero in
            // a hidden page: generate once the grid is shown, then follow its
            // size instead of the window one.
            this._resize_observer = new ResizeObserver(() => {
                if (!grid[0].offsetWidth) {
                    return;
                }
                if (configs) {
                    for (let chart of configs) {
                        this._charts.push(bb.generate(chart));
                    }
                    configs = null;
                } else {
                    for (let chart of this._charts) {
                        chart.resize();
                    }
                }
            });
            this._resize_observer.observe(grid[0]);
        },
        // A function cannot travel as JSON: the server names a "short"
        // format (12.3k, 4.5M) for ticks or labels, the client builds it.
        _set_formats: function(value) {
            let lang = Sao.i18n.BC47(Sao.i18n.getlang());
            let short = function(number) {
                for (let [divisor, suffix] of [[1e9, 'G'], [1e6, 'M'], [1e3, 'k']]) {
                    if (Math.abs(number) >= divisor) {
                        return (number / divisor).toLocaleString(
                            lang, {maximumFractionDigits: 1}) + suffix;
                    }
                }
                return number.toLocaleString(lang, {maximumFractionDigits: 1});
            };
            let short_values = false;
            for (let name of ['x', 'y', 'y2']) {
                let tick = value.axis && value.axis[name] && value.axis[name].tick;
                if (tick && (tick.format == 'short')) {
                    tick.format = short;
                    short_values = short_values || (name != 'x');
                }
            }
            // The tooltip borrows the y tick format by default: keep it exact
            let tooltip_format = (value.tooltip && value.tooltip.format) || {};
            if (short_values && !tooltip_format.value) {
                value.tooltip = Object.assign({}, value.tooltip, {
                    format: Object.assign({}, tooltip_format, {
                        value: (number) => number.toLocaleString(
                            lang, {maximumFractionDigits: 2}),
                    }),
                });
            }
            let labels = value.data.labels;
            if (labels && (labels.format == 'short')) {
                labels.format = short;
            }
        },
        // Hovering a bar or a slice focuses its series, legend included, and
        // the tooltip lists that series only. A line keeps its grouped one.
        _focus_on_hover: function(value) {
            if (value.data.type == 'line') {
                return;
            }
            value.tooltip = Object.assign({grouped: false}, value.tooltip);
            value.data.onover = value.data.onover || function(data) {
                this.focus(data.id);
            };
            value.data.onout = value.data.onout || function() {
                this.revert();
            };
        },
        _set_pie_mode: function(value) {
            if (this.attributes.pie_mode && (this.attributes.pie_mode == 'number')) {
                Object.assign(value, {
                    pie: {
                        label: {
                            format: function (value, ratio, id) {
                                return value;
                            }
                        }
                    },
                    tooltip: {
                        format: {
                            value: function (value, ratio, id) {
                                return value;
                            }
                        }
                    },
                });
            }
        },
    });

    Object.assign(Sao.View.FormXMLViewParser.WIDGETS, {
        'json': Sao.View.Form.JSON,
        'billboard': Sao.View.Form.Billboard,
    });

}());

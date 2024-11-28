# This file is part of Tryton.  The COPYRIGHT file at the top level of
# this repository contains the full copyright notices and license terms.
import gettext
import itertools

from gi.repository import Gdk, Gtk, GLib

import tryton.common as common
from tryton.common.completion import get_completion, update_completion
from tryton.common.domain_parser import quote
from tryton.common.underline import set_underline
from tryton.gui.window.view_form.screen import Screen
from tryton.gui.window.win_form import WinForm
from tryton.gui.window.win_search import WinSearch

from .widget import Widget

_ = gettext.gettext
IncompatibleGroup = object()


class One2Many(Widget):
    expand = True

    def __init__(self, view, attrs):
        super(One2Many, self).__init__(view, attrs)

        self.widget = Gtk.Frame()
        self.widget.set_shadow_type(Gtk.ShadowType.NONE)
        self.widget.get_accessible().set_name(attrs.get('string', ''))
        vbox = Gtk.VBox(homogeneous=False, spacing=2)
        self.widget.add(vbox)
        self._readonly = True
        self._required = False
        self._position = 0
        self._length = 0
        self._incompatible_group = False

        self.title_box = hbox = Gtk.HBox(homogeneous=False, spacing=0)
        hbox.set_border_width(2)

        self.title = Gtk.Label(
            label=set_underline(attrs.get('string', '')),
            use_underline=True, halign=Gtk.Align.START)
        if not attrs.get('expand_toolbar'):
            if attrs.get('collapse_body'):
                click_catcher = Gtk.EventBox.new()
                click_catcher.set_above_child(True)
                click_catcher.connect('button-press-event', self._toggle_body)

                collapse_hbox = Gtk.HBox()
                self.title_expander = Gtk.Image()
                self.title_expander.set_from_pixbuf(
                    common.IconFactory.get_pixbuf('tryton-arrow-down'))
                collapse_hbox.pack_start(
                    self.title_expander, expand=False, fill=False, padding=0)
                collapse_hbox.pack_start(
                    self.title, expand=False, fill=False, padding=0)

                click_catcher.add(collapse_hbox)
                click_catcher.show()
                hbox.pack_start(
                    click_catcher, expand=True, fill=True, padding=0)
            else:
                hbox.pack_start(
                    self.title, expand=True, fill=True, padding=0)

        hbox.pack_start(Gtk.VSeparator(), expand=False, fill=True, padding=0)

        tooltips = common.Tooltips()

        self.but_switch = Gtk.Button(can_focus=False)
        tooltips.set_tip(self.but_switch, _('Switch'))
        self.but_switch.connect('clicked', self.switch_view)
        self.but_switch.add(common.IconFactory.get_image(
                'tryton-switch', Gtk.IconSize.SMALL_TOOLBAR))
        self.but_switch.set_relief(Gtk.ReliefStyle.NONE)
        hbox.pack_start(self.but_switch, expand=False, fill=False, padding=0)

        self.but_pre = Gtk.Button(can_focus=False)
        tooltips.set_tip(self.but_pre, _('Previous'))
        self.but_pre.connect('clicked', self._sig_previous)
        self.but_pre.add(common.IconFactory.get_image(
                'tryton-back', Gtk.IconSize.SMALL_TOOLBAR))
        self.but_pre.set_relief(Gtk.ReliefStyle.NONE)
        hbox.pack_start(self.but_pre, expand=False, fill=False, padding=0)

        self.label = Gtk.Label(label='(_/0)')
        hbox.pack_start(self.label, expand=False, fill=False, padding=0)

        self.but_next = Gtk.Button(can_focus=False)
        tooltips.set_tip(self.but_next, _('Next'))
        self.but_next.connect('clicked', self._sig_next)
        self.but_next.add(common.IconFactory.get_image(
                'tryton-forward', Gtk.IconSize.SMALL_TOOLBAR))
        self.but_next.set_relief(Gtk.ReliefStyle.NONE)
        hbox.pack_start(self.but_next, expand=False, fill=False, padding=0)

        hbox.pack_start(Gtk.VSeparator(), expand=False, fill=True, padding=0)

        self.wid_completion = None
        if attrs.get('add_remove'):

            self.wid_text = Gtk.Entry()
            self.wid_text.set_placeholder_text(_('Search'))
            self.wid_text.set_property('width_chars', 13)
            self.pid_focus = self.wid_text.connect(
                'focus-out-event', self._focus_out)
            hbox.pack_start(self.wid_text, expand=True, fill=True, padding=0)

            if int(self.attrs.get('completion', 1)):
                self.wid_completion = get_completion(
                    search=self.read_access,
                    create=self.create_access)
                self.wid_completion.connect('match-selected',
                    self._completion_match_selected)
                self.wid_completion.connect('action-activated',
                    self._completion_action_activated)
                self.wid_text.set_completion(self.wid_completion)
                self.wid_text.connect('changed', self._update_completion)

            self.but_add = Gtk.Button(can_focus=False)
            tooltips.set_tip(self.but_add, _('Add existing record'))
            self.but_add.connect('clicked', self._sig_add)
            self.but_add.add(common.IconFactory.get_image(
                    'tryton-add', Gtk.IconSize.SMALL_TOOLBAR))
            self.but_add.set_relief(Gtk.ReliefStyle.NONE)
            hbox.pack_start(self.but_add, expand=False, fill=False, padding=0)

            self.but_remove = Gtk.Button(can_focus=False)
            tooltips.set_tip(self.but_remove,
                _('Remove selected record'))
            self.but_remove.connect('clicked', self._sig_remove, True)
            self.but_remove.add(common.IconFactory.get_image(
                    'tryton-remove', Gtk.IconSize.SMALL_TOOLBAR))
            self.but_remove.set_relief(Gtk.ReliefStyle.NONE)
            hbox.pack_start(
                self.but_remove, expand=False, fill=False, padding=0)

            hbox.pack_start(
                Gtk.VSeparator(), expand=False, fill=True, padding=0)

        self.but_new = Gtk.Button(can_focus=False)
        tooltips.set_tip(self.but_new, _('Create a new record'))
        self.but_new.connect('clicked', lambda *a: self._sig_new())
        self.but_new.add(common.IconFactory.get_image(
                'tryton-create', Gtk.IconSize.SMALL_TOOLBAR))
        self.but_new.set_relief(Gtk.ReliefStyle.NONE)
        hbox.pack_start(self.but_new, expand=False, fill=False, padding=0)

        self.but_open = Gtk.Button(can_focus=False)
        tooltips.set_tip(self.but_open, _('Edit selected record'))
        self.but_open.connect('clicked', self._sig_edit)
        self.but_open.add(common.IconFactory.get_image(
                'tryton-open', Gtk.IconSize.SMALL_TOOLBAR))
        self.but_open.set_relief(Gtk.ReliefStyle.NONE)
        hbox.pack_start(self.but_open, expand=False, fill=False, padding=0)

        self.but_del = Gtk.Button(can_focus=False)
        tooltips.set_tip(self.but_del, _('Delete selected record'))
        self.but_del.connect('clicked', self._sig_remove, False)
        self.but_del.add(common.IconFactory.get_image(
                'tryton-delete', Gtk.IconSize.SMALL_TOOLBAR))
        self.but_del.set_relief(Gtk.ReliefStyle.NONE)
        hbox.pack_start(self.but_del, expand=False, fill=False, padding=0)

        self.but_undel = Gtk.Button(can_focus=False)
        tooltips.set_tip(self.but_undel, _('Undelete selected record <Ins>'))
        self.but_undel.connect('clicked', self._sig_undelete)
        self.but_undel.add(common.IconFactory.get_image(
                'tryton-undo', Gtk.IconSize.SMALL_TOOLBAR))
        self.but_undel.set_relief(Gtk.ReliefStyle.NONE)
        hbox.pack_start(self.but_undel, expand=False, fill=False, padding=0)

        tooltips.enable()

        frame = Gtk.Frame()
        frame.add(hbox)
        # XXX: support expand_toolbar
        if attrs.get('expand_toolbar'):
            frame.set_shadow_type(Gtk.ShadowType.NONE)
        else:
            frame.set_shadow_type(Gtk.ShadowType.OUT)
            vbox.pack_start(frame, expand=False, fill=True, padding=0)

        model = attrs['relation']
        breadcrumb = list(self.view.screen.breadcrumb)
        breadcrumb.append(
            attrs.get('string') or common.MODELNAME.get(model))
        self.screen = Screen(model,
            mode=attrs.get('mode', 'tree,form').split(','),
            view_ids=attrs.get('view_ids', '').split(','),
            views_preload=attrs.get('views', {}),
            order=attrs.get('order'),
            row_activate=self._on_activate,
            exclude_field=attrs.get('relation_field', None),
            limit=None,
            context=self.view.screen.context,
            breadcrumb=breadcrumb)
        self.screen.pre_validate = bool(int(attrs.get('pre_validate', 0)))
        self.screen.windows.append(self)
        if self.attrs.get('group'):
            self.screen._multiview_form = view
            self.screen._multiview_group = self.attrs['group']
            wgroup = view.widget_groups.setdefault(self.attrs['group'], [])
            if self.screen.current_view.view_type == 'tree':
                if (wgroup
                        and wgroup[0].screen.current_view.view_type == 'tree'):
                    raise ValueError("Wrong multiview definition")
                wgroup.insert(0, self)
            else:
                wgroup.append(self)

        vbox.pack_start(self.screen.widget, expand=True, fill=True, padding=0)

        self.title.set_mnemonic_widget(
            self.screen.current_view.mnemonic_widget)

        self.screen.widget.connect('key_press_event', self.on_keypress)
        if self.attrs.get('add_remove'):
            self.wid_text.connect('key_press_event', self.on_keypress)

        self._popup = False

        if (not attrs.get('expand_toolbar')
                and attrs.get('collapse_body') == '1'):
            def hide_body():
                self.screen.widget.hide()
                self.widget.set_vexpand(False)
                self.widget.set_size_request(-1, -1)
                self.title_expander.set_from_pixbuf(
                    common.IconFactory.get_pixbuf('tryton-arrow-right'))
            GLib.idle_add(hide_body)

    def get_access(self, type_):
        model = self.attrs['relation']
        if model:
            return common.MODELACCESS[model][type_]
        else:
            return True

    @property
    def read_access(self):
        return self.get_access('read')

    @property
    def create_access(self):
        return int(self.attrs.get('create', 1)) and self.get_access('create')

    @property
    def write_access(self):
        return self.get_access('write')

    @property
    def delete_access(self):
        return int(self.attrs.get('delete', 1)) and self.get_access('delete')

    def _toggle_body(self, eventbox, event):
        if self.screen.widget.props.visible:
            self.screen.widget.hide()
            self.widget.set_vexpand(False)
            self.widget.set_size_request(-1, -1)
            self.title_expander.set_from_pixbuf(
                common.IconFactory.get_pixbuf('tryton-arrow-right'))
        else:
            self.screen.widget.show()
            self.widget.set_vexpand(True)
            self.widget.set_size_request(
                int(self.attrs.get('width', -1)),
                int(self.attrs.get('height', -1)))
            self.title_expander.set_from_pixbuf(
                common.IconFactory.get_pixbuf('tryton-arrow-down'))

    def on_keypress(self, widget, event):
        if ((event.keyval == Gdk.KEY_F3)
                and self.but_new.get_property('sensitive')):
            self._sig_new()
            return True
        if event.keyval == Gdk.KEY_F2:
            if widget == self.screen.widget:
                self._sig_edit(widget)
                return True
            elif widget == self.wid_text:
                self._sig_add(widget)
                return True
        if event.keyval == Gdk.KEY_F4:
            self.switch_view(widget)
        if (event.keyval in [Gdk.KEY_Delete, Gdk.KEY_KP_Delete]
                and widget == self.screen.widget):
            remove = not (event.state & Gdk.ModifierType.CONTROL_MASK)
            if remove and self.attrs.get('add_remove'):
                but = self.but_remove
            else:
                remove = False
                but = self.but_del
            if but.get_property('sensitive'):
                self._sig_remove(widget, remove)
                return True
        if event.keyval == Gdk.KEY_Insert and widget == self.screen.widget:
            self._sig_undelete(widget)
            return True
        if self.attrs.get('add_remove'):
            editable = self.wid_text.get_editable()
            activate_keys = [Gdk.KEY_Tab, Gdk.KEY_ISO_Left_Tab]
            if not self.wid_completion:
                activate_keys.append(Gdk.KEY_Return)
            if (widget == self.wid_text
                    and event.keyval in activate_keys
                    and editable
                    and self.wid_text.get_text()):
                self._sig_add()
                self.wid_text.grab_focus()
        return False

    def destroy(self):
        if self.attrs.get('add_remove'):
            self.wid_text.disconnect(self.pid_focus)
        self.screen.destroy()

    def _on_activate(self):
        self._sig_edit()

    def switch_view(self, widget):
        self.screen.switch_view()

        mnemonic_widget = self.screen.current_view.mnemonic_widget
        string = self.attrs.get('string', '')
        if mnemonic_widget:
            string = set_underline(string)
        self.title.set_mnemonic_widget(mnemonic_widget)
        self.title.set_label(string)

    @property
    def modified(self):
        # JCA : Check current_view is not None
        return (self.screen.current_view.modified if self.screen.current_view
            else False)

    def _readonly_set(self, value):
        self._readonly = value
        self._set_button_sensitive()
        self._set_label_state()

    def _required_set(self, value):
        self._required = value
        self._set_label_state()

    def _set_label_state(self):
        common.apply_label_attributes(
            self.title, self._readonly, self._required)

    def _set_button_sensitive(self):
        if self.record and self.field:
            field_size = self.record.expr_eval(self.attrs.get('size'))
            o2m_size = len(self.field.get_eval(self.record))
            size_limit = (field_size is not None
                and o2m_size >= field_size >= 0)
        else:
            o2m_size = None
            size_limit = False

        has_form = ('form' in (x.view_type for x in self.screen.views)
            or 'form' in self.screen.view_to_load)

        first = last = False
        if isinstance(self._position, int):
            first = self._position <= 1
            last = self._position >= self._length
        deletable = self.screen.deletable
        view_type = self.screen.current_view.view_type
        has_views = self.screen.number_of_views > 1

        self.but_switch.set_sensitive(
            (self._position or view_type == 'form') and has_views)
        self.but_new.set_sensitive(bool(
                not self._readonly
                and self.create_access
                and not size_limit
                and (has_form or self.screen.current_view.editable)))
        self.but_del.set_sensitive(bool(
                not self._readonly
                and self.delete_access
                and deletable
                and self._position))
        self.but_undel.set_sensitive(bool(
                not self._readonly
                and not size_limit
                and self._position))
        self.but_open.set_sensitive(bool(
                self._position
                and self.read_access
                and has_form))
        self.but_next.set_sensitive(bool(
                self._position
                and not last))
        self.but_pre.set_sensitive(bool(
                self._position
                and not first))
        if self.attrs.get('add_remove'):
            self.but_add.set_sensitive(bool(
                    not self._readonly
                    and not size_limit
                    and self.write_access
                    and self.read_access))
            self.but_remove.set_sensitive(bool(
                    not self._readonly
                    and self._position
                    and self.write_access
                    and self.read_access))
            self.wid_text.set_sensitive(self.but_add.get_sensitive())
            self.wid_text.set_editable(self.but_add.get_sensitive())

    def _validate(self):
        self.view.set_value()
        record = self.screen.current_record
        if record:
            fields = self.screen.current_view.get_fields() \
                if self.screen.current_view else None
            if not record.validate(fields):
                self.screen.display(set_cursor=True)
                return False
            if self.screen.pre_validate and not record.pre_validate():
                return False
        return True

    def _sequence(self):
        for view in self.screen.views:
            if view.view_type == 'tree':
                sequence = view.attributes.get('sequence')
                if sequence:
                    return sequence

    def _sig_new(self, defaults=None):
        if not self.create_access:
            return
        if not self._validate():
            return
        if self.attrs.get('add_remove'):
            defaults = defaults.copy() if defaults is not None else {}
            defaults['rec_name'] = self.wid_text.get_text()

        if self.attrs.get('product'):
            self._new_product(defaults)
        else:
            self._new_single(defaults)

    def _new_single(self, defaults=None):
        if self._popup:
            return
        else:
            self._popup = True
        sequence = self._sequence()

        def update_sequence():
            if sequence:
                self.screen.group.set_sequence(
                    field=sequence, position=self.screen.new_position)
            self._popup = False

        if self.screen.current_view.creatable:
            self.screen.new(delay_on_changes=True)
            self.screen.current_view.widget.set_sensitive(True)
            update_sequence()
        else:
            field_size = self.record.expr_eval(self.attrs.get('size')) or -1
            field_size -= len(self.field.get_eval(self.record)) + 1
            WinForm(
                self.screen, lambda a: update_sequence(), new=True,
                defaults=defaults, many=field_size, delay_on_changes=True)

    def _new_product(self, defaults=None):
        fields = self.attrs['product'].split(',')
        product = {}

        if self._popup:
            return
        else:
            self._popup = True
        first = self.screen.new(default=False, delay_on_changes=True)
        default = first.default_get(defaults=defaults)
        first.set_default(default, delay_on_changes=True)

        def search_set(*args):
            if not fields:
                return make_product()
            field = self.screen.group.fields[fields.pop()]
            relation = field.attrs.get('relation')
            if not relation:
                search_set()

            domain = field.domain_get(first)
            context = field.get_search_context(first)
            order = field.get_search_order(first)

            def callback(result):
                if result:
                    product[field.name] = result

            win_search = WinSearch(relation, callback, sel_multi=True,
                context=context, domain=domain, order=order,
                title=self.attrs.get('string'), delay_on_changes=True)
            win_search.win.connect('destroy', search_set)
            win_search.screen.search_filter()
            win_search.show()

        def make_product():
            self._popup = False
            self.screen.group.remove(first, remove=True)
            if not product:
                return

            fields = list(product.keys())
            for values in itertools.product(*list(product.values())):
                record = self.screen.new(default=False, delay_on_changes=True)
                default_value = default.copy()
                for field, value in zip(fields, values):
                    id_, rec_name = value
                    default_value[field] = id_
                    default_value[field + '.rec_name'] = rec_name
                record.set_default(default_value, delay_on_changes=True)

            sequence = self._sequence()
            if sequence:
                self.screen.group.set_sequence(
                    field=sequence, position=self.screen.new_position)

        search_set()

    def _sig_edit(self, widget=None):
        if not self.but_open.props.sensitive:
            return
        if not self._validate():
            return
        record = self.screen.current_record
        if record:
            if self._popup:
                return
            else:
                self._popup = True

            def callback(result):
                self._popup = False
            WinForm(self.screen, callback)

    def _sig_next(self, widget):
        if not self._validate():
            return
        self.screen.display_next()

    def _sig_previous(self, widget):
        if not self._validate():
            return
        self.screen.display_prev()

    def _sig_remove(self, widget, remove=False):
        writable = not self.screen.readonly
        deletable = self.screen.deletable
        if remove:
            if not self.write_access or not writable or not self.read_access:
                return
        else:
            if not self.delete_access or not deletable:
                return
        self.screen.remove(remove=remove)

    def _sig_undelete(self, button):
        self.screen.unremove()

    def _sig_add(self, *args):
        if not self.write_access or not self.read_access:
            return
        domain = self.field.domain_get(self.record)
        context = self.field.get_search_context(self.record)
        domain = [domain, self.record.expr_eval(self.attrs.get('add_remove'))]
        removed_ids = self.field.get_removed_ids(self.record)
        domain = ['OR', domain, ('id', 'in', removed_ids)]
        text = self.wid_text.get_text()

        if self._popup:
            return
        else:
            self._popup = True

        sequence = self._sequence()

        def callback(result):
            if result:
                ids = [x[0] for x in result]
                self.screen.load(ids, modified=True)
                if sequence:
                    self.screen.group.set_sequence(
                        field=sequence, position=self.screen.new_position)
            self.screen.set_cursor()
            self.wid_text.set_text('')
            self._popup = False

        order = self.field.get_search_order(self.record)
        win = WinSearch(self.attrs['relation'], callback, sel_multi=True,
            context=context, domain=domain, order=order,
            view_ids=self.attrs.get('view_ids', '').split(','),
            views_preload=self.attrs.get('views', {}),
            new=self.but_new.get_property('sensitive'),
            title=self.attrs.get('string'),
            exclude_field=self.attrs.get('relation_field'))
        win.screen.search_filter(quote(text))
        win.show()

    def record_message(self, position, size, *args):
        self._position = position
        self._length = size
        name = str(position) if position else '_'
        selected = len(self.screen.selected_records)
        if selected > 1:
            name += '#%i' % selected
        name = '(%s/%s)' % (name, common.humanize(size))
        self.label.set_text(name)
        self._set_button_sensitive()

    def display(self):
        super(One2Many, self).display()

        self._set_button_sensitive()

        if not self.field:
            self.screen.new_group()
            self.screen.current_record = None
            self.screen.parent = None
            self.screen.display()
            return False
        new_group = self.field.get_client(self.record)

        if self.attrs.get('group') and self.attrs.get('mode') == 'form':
            self.invisible_set(not self.visible or self._incompatible_group)
        if (id(self.screen.group) != id(new_group)
                and self.screen.model_name == new_group.model_name):
            self.screen.group = new_group
            if (self.screen.current_view.view_type == 'form'
                    and self.screen.group):
                self.screen.current_record = self.screen.group[0]
        domain = []
        size_limit = None
        if self.record:
            domain = self.field.domain_get(self.record)
            size_limit = self.record.expr_eval(self.attrs.get('size'))
        if self._readonly or not self.create_access:
            if size_limit is None:
                size_limit = len(self.screen.group)
            else:
                size_limit = min(size_limit, len(self.screen.group))
        if self.screen.get_domain() != domain:
            self.screen.domain = domain
        self.screen.size_limit = size_limit
        self.screen.display()
        return True

    def set_value(self):
        self.screen.current_view.set_value()
        if self.screen.modified():  # TODO check if required
            self.view.screen.record_modified(display=False)
        return True

    def _completion_match_selected(self, completion, model, iter_):
        record_id, defaults = model.get(iter_, 1, 2)
        if record_id is not None:
            self.screen.load([record_id], modified=True)
            self.wid_text.set_text('')
            self.wid_text.grab_focus()

            completion_model = self.wid_completion.get_model()
            completion_model.clear()
            completion_model.search_text = self.wid_text.get_text()
        else:
            self._sig_new(defaults)
        return True

    def _update_completion(self, widget):
        if self._readonly:
            return
        if not self.record:
            return
        model = self.attrs['relation']
        domain = self.field.domain_get(self.record)
        domain = [domain, self.record.expr_eval(self.attrs.get('add_remove'))]
        removed_ids = self.field.get_removed_ids(self.record)
        domain = ['OR', domain, ('id', 'in', removed_ids)]
        update_completion(self.wid_text, self.record, self.field, model,
            domain=domain)

    def _completion_action_activated(self, completion, index):
        if index == 0:
            self._sig_add()
            self.wid_text.grab_focus()
        elif index == 1:
            self._sig_new()

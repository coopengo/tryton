# This file is part of Tryton.  The COPYRIGHT file at the top level of
# this repository contains the full copyright notices and license terms.
from gi.repository import Gio, GLib, GObject, Gtk

from tryton.common import common

from . import View
from .form import ViewForm


class ListBoxViewForm(ViewForm):

    def __init__(self, view_id, screen, xml):
        self._record = None
        super().__init__(view_id, screen, xml)
        self.scroll.set_policy(Gtk.PolicyType.NEVER, Gtk.PolicyType.NEVER)

    @property
    def record(self):
        return self._record

    @record.setter
    def record(self, value):
        self._record = value

    def button_clicked(self, widget):
        if self.screen.selected_records == [self.record]:
            super().button_clicked(widget)


class ListBoxItem(GObject.Object):

    def __init__(self, record):
        super().__init__()
        self.record = record


class ListBoxModel(GObject.Object, Gio.ListModel):

    def __init__(self, group):
        super().__init__()
        self.group = group
        self._records = {}

    def do_get_item(self, position):
        if position >= len(self.group):
            return None
        record = self.group[position]
        if record.id not in self._records:
            self._records[record.id] = ListBoxItem(record)
        return self._records[record.id]

    def do_get_item_type(self):
        return ListBoxItem

    def do_get_n_items(self):
        return len(self.group)


class ViewListForm(View):
    editable = True
    xml_parser = None

    def __init__(self, view_id, screen, xml):
        super().__init__(view_id, screen, xml)
        self.creatable = bool(int(self.attributes.get('creatable', 1)))
        self.view_type = 'list-form'

        self.form_xml = xml
        self.listbox = Gtk.ListBox.new()
        self.listbox.connect('row-selected', self._row_selected)
        self.listbox.props.activate_on_single_click = False
        self.listbox.set_selection_mode(Gtk.SelectionMode.MULTIPLE)
        self.widget = Gtk.ScrolledWindow.new()
        self.widget.add_with_viewport(self.listbox)
        self._model = None
        self._view_forms = []

    def display(self, force=False):
        if self._model is None or self._model.group is not self.group:
            self._view_forms = []
            self._model = ListBoxModel(self.group)
            self.listbox.bind_model(self._model, self._create_form)
        for idx, view_form in enumerate(self._view_forms):
            view_form.display()

    def _create_form(self, item):
        view_form = ListBoxViewForm(self.view_id, self.screen, self.form_xml)
        view_form.record = item.record
        view_form.listform = self
        view_form.widget.props.margin = 3
        self._view_forms.append(view_form)
        frame = Gtk.Frame.new()
        frame.add(view_form.widget)
        frame.show_all()
        return frame

    def set_value(self):
        for view_form in self._view_forms:
            view_form.set_value()

    def get_fields(self):
        if self._view_forms:
            return self._view_forms[0].get_fields()
        return []

    def get_buttons(self):
        if self._view_forms:
            return self._view_forms[0].get_buttons()
        return []

    def destroy(self):
        for view_form in self._view_forms:
            view_form.destroy()
        self.widget.destroy()

    @property
    def selected_records(self):
        selected_rows = self.listbox.get_selected_rows()
        return [
            self._model.get_item(r.get_index()).record for r in selected_rows]

    @property
    def listed_records(self):
        return list(self._model.group)

    def group_list_changed(self, group, action, *args):
        # Only those actions have a record in the signal data
        if action not in {'record-added', 'record-removed'}:
            return
        if action == 'record-added':
            record, position = args
            if group != record.group:
                return
            self._model.emit('items-changed', position, 0, 1)
            self._view_forms.insert(position, self._view_forms.pop())
        elif action == 'record-removed':
            record, position = args
            if group != record.group:
                return
            self._model.emit('items-changed', position, 1, 0)
            self._view_forms.pop(position)

    def set_cursor(self, new=False, reset_view=True):
        for idx, form in enumerate(self._view_forms):
            if form.record == self.record:
                self._select_show_row(idx)
                break

    def get_selected_paths(self):
        return [[r.id] for r in self.selected_records]

    def select_nodes(self, nodes):
        if not nodes:
            return
        nodes = {n[0] for n in nodes}
        self.listbox.handler_block_by_func(self._row_selected)
        try:
            self.listbox.unselect_all()
            for idx, view_form in enumerate(self._view_forms):
                if view_form.record.id in nodes:
                    row = self.listbox.get_row_at_index(idx)
                    if not row:
                        continue
                    self.listbox.select_row(row)
        finally:
            self.listbox.handler_unblock_by_func(self._row_selected)

    def _row_selected(self, listbox, row):
        previous_record = self.record
        if (previous_record
                and previous_record not in previous_record.group):
            previous_record = None

        if row:
            self.record = self._model.get_item(row.get_index()).record
        else:
            self.record = None

        def go_previous():
            self.record = previous_record
            self.set_cursor()

        def save():
            if not previous_record.destroyed:
                if not previous_record.save():
                    go_previous()

        def pre_validate():
            if not previous_record.destroyed:
                if not previous_record.pre_validate():
                    go_previous()

        if previous_record and previous_record != self.record:
            if not self.screen.parent:
                if not previous_record.validate(self.get_fields()):
                    go_previous()
                    return True
                GLib.idle_add(save)
            elif self.screen.pre_validate:
                GLib.idle_add(pre_validate)

    @common.idle_add
    def _select_show_row(self, index):
        # translate_coordinates requires that both widgets are realized
        if not self.listbox.get_realized():
            return
        # unselect_all triggers a loop in _row_selected if the record is not
        # valid
        self.listbox.handler_block_by_func(self._row_selected)
        try:
            self.listbox.unselect_all()
        finally:
            self.listbox.handler_unblock_by_func(self._row_selected)
        row = self.listbox.get_row_at_index(index)
        if not row or not row.get_realized():
            return
        self.listbox.select_row(row)
        y_position = row.translate_coordinates(self.listbox, 0, 0)[1]
        y_size = row.get_allocated_height()
        vadjustment = self.widget.get_vadjustment()
        vadjustment.clamp_page(y_position, y_position + y_size)

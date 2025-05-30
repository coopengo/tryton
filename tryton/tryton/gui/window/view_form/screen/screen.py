# This file is part of Tryton.  The COPYRIGHT file at the top level of
# this repository contains the full copyright notices and license terms.
"Screen"
import calendar
import collections
import datetime
import functools
import gettext
import json
import logging
import urllib.parse
import xml.dom.minidom
from operator import itemgetter

from gi.repository import GLib, Gtk

from tryton.action import Action
from tryton.common import (
    MODELACCESS, RPCContextReload, RPCException, RPCExecute, get_monitor_size,
    node_attributes, sur, warning)
from tryton.common.domain_inversion import canonicalize
from tryton.common.domain_parser import DomainParser
from tryton.config import CONFIG
from tryton.gui.window.infobar import InfoBar
from tryton.gui.window.view_form.model.group import Group
from tryton.gui.window.view_form.view import View
from tryton.gui.window.view_form.view.screen_container import ScreenContainer
from tryton.jsonrpc import JSONEncoder
from tryton.pyson import PYSONDecoder
from tryton.rpc import clear_cache

_ = gettext.gettext
logger = logging.getLogger(__name__)


class Screen:
    "Screen"

    # Width of tree columns per model
    # It is shared with all connection but it is the price for speed.
    tree_column_width = collections.defaultdict(lambda: {})
    tree_column_optional = {}

    def __init__(self, model_name, **attributes):
        context = attributes.get('context', {})
        self._current_domain = []
        self.limit = attributes.get('limit', CONFIG['client.limit'])
        self.position = 0
        self.offset = 0
        self.windows = []

        self.readonly = attributes.get('readonly', False)
        if not (MODELACCESS[model_name]['write']
                or MODELACCESS[model_name]['create']):
            self.readonly = True
        self.search_count = 0
        if not attributes.get('row_activate'):
            self.row_activate = self.default_row_activate
        else:
            self.row_activate = attributes['row_activate']
        self.domain = attributes.get('domain', [])
        self.context_domain = attributes.get('context_domain')
        self.size_limit = None
        self.views_preload = attributes.get('views_preload', {})
        self.model_name = model_name
        self.views = []
        self.view_ids = attributes.get('view_ids', [])[:]
        self.parent = None
        self.parent_name = None
        self.exclude_field = attributes.get('exclude_field')
        self.filter_widget = None
        self.tree_states = collections.defaultdict(
            lambda: collections.defaultdict(lambda: None))
        self.tree_states_done = set()
        self._multiview_form = None
        self._multiview_group = None
        self.__group = None
        self.__current_record = None
        self.new_group(context or {})
        self.current_record = None
        self.screen_container = ScreenContainer(
            attributes.get('tab_domain'), attributes.get('show_filter', True))
        self.screen_container.alternate_view = attributes.get(
            'alternate_view', False)
        self.widget = self.screen_container.widget_get()
        self.breadcrumb = attributes.get('breadcrumb') or []

        self.context_screen = None
        if attributes.get('context_model'):
            self.context_screen = Screen(
                attributes['context_model'], mode=['form'], context=context)
            self.context_screen.parent_screen = self
            self.context_screen.new()
            context_widget = self.context_screen.widget

            def walk_descendants(widget):
                yield widget
                if not hasattr(widget, 'get_children'):
                    return
                for child in widget.get_children():
                    for widget in walk_descendants(child):
                        yield widget

            for widget in reversed(list(walk_descendants(context_widget))):
                if isinstance(widget, Gtk.Entry):
                    widget.connect_after(
                        'activate', self.screen_container.activate)
                elif isinstance(widget, Gtk.CheckButton):
                    widget.connect_after(
                        'toggled', self.screen_container.activate)

            def remove_bin(widget):
                assert isinstance(widget, (Gtk.ScrolledWindow, Gtk.Viewport))
                parent = widget.get_parent()
                parent.remove(widget)
                child = widget.get_child()
                while isinstance(child, (Gtk.ScrolledWindow, Gtk.Viewport)):
                    child = child.get_child()
                child.get_parent().remove(child)
                parent.add(child)
                return child

            # Remove first level Viewport and ScrolledWindow to fill the Vbox
            remove_bin(self.context_screen.screen_container.viewport)
            if self.context_screen.current_view:
                remove_bin(
                    self.context_screen.current_view.widget.get_children()[0])

            self.screen_container.filter_vbox.pack_start(
                context_widget, expand=False, fill=True, padding=0)
            self.screen_container.filter_vbox.reorder_child(
                context_widget, 0)
            self.context_screen.widget.show()

        self.__current_view = 0
        self.search_value = attributes.get('search_value')
        self.fields_view_tree = {}
        self.order = self.default_order = attributes.get('order')
        self.view_to_load = []
        self._domain_parser = {}
        self.pre_validate = False
        mode = attributes.get('mode')
        if mode is None:
            mode = ['tree', 'form']
        self.view_to_load = mode[:]
        if self.view_ids or self.view_to_load:
            self.switch_view()

    def __repr__(self):
        return '<Screen %s at %s>' % (self.model_name, id(self))

    @property
    def readonly(self):
        return (self.__readonly
            or any(r.readonly for r in self.selected_records))

    @readonly.setter
    def readonly(self, value):
        self.__readonly = value

    @property
    def deletable(self):
        return all(r.deletable for r in self.selected_records)

    @property
    def count_limit(self):
        return self.limit * 100 + self.offset

    def search_active(self, active=True):
        if active and not self.parent:
            self.screen_container.set_screen(self)
            self.screen_container.show_filter()
        else:
            self.screen_container.hide_filter()

    @property
    def domain_parser(self):
        view_id = self.current_view.view_id if self.current_view else None

        if view_id in self._domain_parser:
            return self._domain_parser[view_id]

        if view_id not in self.fields_view_tree:
            context = self.context
            context['view_tree_width'] = CONFIG['client.save_tree_width']
            context['screen_size'] = get_monitor_size()
            try:
                self.fields_view_tree[view_id] = view_tree = RPCExecute(
                    'model', self.model_name, 'fields_view_get', False, 'tree',
                    context=context)
            except RPCException:
                view_tree = {
                    'fields': {},
                    }
        else:
            view_tree = self.fields_view_tree[view_id]

        fields = view_tree['fields'].copy()
        for name in fields:
            if fields[name]['type'] not in {
                    'selection', 'multiselection', 'reference'}:
                continue
            if isinstance(fields[name]['selection'], (tuple, list)):
                continue
            props = fields[name] = fields[name].copy()
            props['selection'] = self.get_selection(props)

        if 'arch' in view_tree:
            # Filter only fields in XML view
            xml_dom = xml.dom.minidom.parseString(view_tree['arch'])
            root_node, = xml_dom.childNodes
            ofields = collections.OrderedDict()
            for node in root_node.childNodes:
                if node.nodeName != 'field':
                    continue
                attributes = node_attributes(node)
                name = attributes['name']
                # If a field is defined multiple times in the XML,
                # take only the first definition
                if name in ofields:
                    continue
                ofields[name] = fields[name]
                for attr in ['string', 'factor']:
                    if attributes.get(attr):
                        ofields[name][attr] = attributes[attr]
                symbol = attributes.get('symbol')
                if symbol and symbol not in ofields:
                    ofields[symbol] = fields[symbol]
            fields = ofields

        # Add common fields
        for name, string, type_ in (
                ('id', _('ID'), 'integer'),
                ('create_uid', _('Created by'), 'many2one'),
                ('create_date', _('Created at'), 'datetime'),
                ('write_uid', _('Edited by'), 'many2one'),
                ('write_date', _('Edited at'), 'datetime'),
                ):
            if name not in fields:
                fields[name] = {
                    'string': string,
                    'name': name,
                    'type': type_,
                    }
                if type_ == 'datetime':
                    fields[name]['format'] = '"%H:%M:%S"'

        domain_parser = DomainParser(fields, self.context)
        self._domain_parser[view_id] = domain_parser
        return domain_parser

    def get_selection(self, props):
        try:
            change_with = props.get('selection_change_with')
            if change_with:
                selection = RPCExecute('model', self.model_name,
                    props['selection'], dict((p, None) for p in change_with))
            else:
                selection = RPCExecute('model', self.model_name,
                    props['selection'])
        except RPCException:
            selection = []
        selection.sort(key=itemgetter(1))
        return selection

    def search_prev(self, search_string):
        if self.limit:
            self.offset -= self.limit
        self.search_filter(search_string=search_string)

    def search_next(self, search_string):
        if self.limit:
            self.offset += self.limit
        self.search_filter(search_string=search_string)

    def search_complete(self, search_string):
        return list(self.domain_parser.completion(search_string))

    def search_filter(self, search_string=None, only_ids=False):
        if self.context_screen and not only_ids:
            context_record = self.context_screen.current_record
            if not context_record.validate():
                self.clear()
                self.context_screen.display(set_cursor=True)
                return False
            context = self.local_context
            screen_context = self.context_screen.get_on_change_value()
            screen_context.pop('id')
            context.update(screen_context)
            self.new_group(context)

        domain = self.search_domain(search_string, True)
        if (canonicalized := canonicalize(domain)) != self._current_domain:
            self._current_domain = canonicalized
            self.offset = 0

        context = self.context
        if (self.screen_container.but_active.props.visible
                and self.screen_container.but_active.get_active()):
            context['active_test'] = False
        try:
            ids = RPCExecute('model', self.model_name, 'search', domain,
                self.offset, self.limit, self.order, context=context)
        except RPCException:
            ids = []
        if not only_ids:
            if self.limit is not None and len(ids) == self.limit:
                try:
                    self.search_count = RPCExecute(
                        'model', self.model_name, 'search_count',
                        domain, 0, self.count_limit, context=context,
                        process_exception=False)
                except RPCException:
                    self.search_count = 0
            else:
                self.search_count = len(ids)
        self.screen_container.but_prev.set_sensitive(bool(self.offset))
        if (self.limit is not None
                and len(ids) == self.limit
                and self.search_count > self.limit + self.offset):
            self.screen_container.but_next.set_sensitive(True)
        else:
            self.screen_container.but_next.set_sensitive(False)
        if only_ids:
            return ids
        self.clear()
        self.load(ids)
        self.count_tab_domain()
        return bool(ids)

    def search_domain(self, search_string=None, set_text=False, with_tab=True):
        domain = []
        # Test first parent to avoid calling unnecessary domain_parser
        if not self.parent and self.domain_parser:
            if search_string is not None:
                domain = self.domain_parser.parse(search_string)
            else:
                domain = self.search_value
                self.search_value = None
            if set_text:
                self.screen_container.set_text(
                    self.domain_parser.string(domain))
        else:
            domain = [('id', 'in', [x.id for x in self.group])]

        win_domain = self.get_domain()
        if domain:
            if win_domain:
                domain = ['AND', domain, win_domain]
        else:
            domain = win_domain

        if (self.screen_container.but_active.props.visible
                and self.screen_container.but_active.get_active()):
            if domain:
                domain = [domain, ('active', '=', False)]
            else:
                domain = [('active', '=', False)]
        if self.current_view and self.current_view.view_type == 'calendar':
            if domain:
                domain = ['AND', domain, self.current_view.current_domain()]
            else:
                domain = self.current_view.current_domain()
        if self.context_domain:
            decoder = PYSONDecoder(self.context)
            domain = ['AND', domain, decoder.decode(self.context_domain)]
        if with_tab:
            tab_domain = self.screen_container.get_tab_domain()
            if tab_domain:
                domain = ['AND', domain, tab_domain]
        return domain

    def count_tab_domain(self, current=False):
        def set_tab_counter(count, idx):
            try:
                count = count()
            except RPCException:
                count = None
            self.screen_container.set_tab_counter(count, idx)
        screen_domain = self.search_domain(
            self.screen_container.get_text(), with_tab=False)
        index = self.screen_container.get_tab_index()
        for idx, (name, domain, count) in enumerate(
                self.screen_container.tab_domain):
            if not count or (current and idx != index):
                continue
            domain = ['AND', self.screen_container.get_tab_domain_for_idx(idx),
                screen_domain]
            set_tab_counter(lambda: None, idx)
            RPCExecute('model', self.model_name,
                'search_count', domain, 0, 1000, context=self.context,
                callback=functools.partial(set_tab_counter, idx=idx))

    def get_domain(self):
        if not self.domain or not isinstance(self.domain, str):
            return self.domain
        decoder = PYSONDecoder(self.context)
        return decoder.decode(self.domain)

    @property
    def context(self):
        context = self.group.context
        if self.context_screen:
            context['context_model'] = self.context_screen.model_name
        return context

    @property
    def local_context(self):
        context = self.group.local_context
        if self.context_screen:
            context['context_model'] = self.context_screen.model_name
        return context

    def __get_group(self):
        return self.__group

    def __set_group(self, group):
        fields = {}
        fields_views = {}
        if self.group is not None:
            for name, field in self.group.fields.items():
                fields[name] = field.attrs
                fields_views[name] = field.views
            if self in self.group.screens:
                self.group.screens.remove(self)
            group.on_write.update(self.group.on_write)
        self.tree_states_done.clear()
        self.__group = group
        self.group.screens.append(self)
        self.parent = group.parent
        self.parent_name = group.parent_name
        if self.parent:
            self.filter_widget = None
            self.order = None
        self.__group.add_fields(fields)
        self.current_record = None
        for name, views in fields_views.items():
            self.__group.fields[name].views.update(views)
        self.__group.exclude_field = self.exclude_field

    group = property(__get_group, __set_group)

    def new_group(self, context=None):
        context = context if context is not None else self.context
        self.group = Group(self.model_name, {}, domain=self.domain,
            context=context, readonly=self.__readonly)

    def group_list_changed(self, group, action, *args):
        for view in self.views:
            if hasattr(view, 'group_list_changed'):
                view.group_list_changed(group, action, *args)

    def record_modified(self, display=True):
        for window in self.windows:
            if hasattr(window, 'record_modified'):
                window.record_modified()
        if display:
            self.display()

    def record_notify(self, notifications):
        for window in self.windows:
            if isinstance(window, InfoBar):
                window.info_bar_refresh('notification')
                for type_, message in notifications:
                    type_ = {
                        'info': Gtk.MessageType.INFO,
                        'warning': Gtk.MessageType.WARNING,
                        'error': Gtk.MessageType.ERROR,
                        }.get(type_, Gtk.MessageType.WARNING)
                    window.info_bar_add(message, type_, 'notification')

    def record_message(self, position, size, max_size, record_id):
        for window in self.windows:
            if hasattr(window, 'record_message'):
                window.record_message(position, size, max_size, record_id)

    def record_saved(self):
        for window in self.windows:
            if hasattr(window, 'record_saved'):
                window.record_saved()

    def update_resources(self, resources):
        for window in self.windows:
            if hasattr(window, 'update_resources'):
                window.update_resources(resources)

    def has_update_resources(self):
        return any(hasattr(w, 'update_resources') for w in self.windows)

    def __get_current_record(self):
        if (self.__current_record is not None
                and self.__current_record.group is None):
            self.__current_record = None
        return self.__current_record

    def __set_current_record(self, record):
        if self.__current_record == record and record:
            return
        self.__current_record = record
        if record:
            try:
                self.position = self.group.index(record) + self.offset + 1
            except ValueError:
                # XXX offset?
                self.position = -1
        else:
            self.position = 0
        self.record_message(
            self.position, len(self.group) + self.offset,
            self.search_count, record and record.id)
        # Coog Specific for multimixed view
        # Somehow _validate_synced_group should be called, but it does not
        # work as intended yet.
        self._sync_group()
        self.update_resources(record.resources if record else None)
        # update resources after 1 second
        GLib.timeout_add(1000, self._update_resources, record)

    current_record = property(__get_current_record, __set_current_record)

    def _validate_synced_group(self):
        if not self._multiview_form or self.current_view.view_type != 'tree':
            return True
        if self.current_record is None:
            return True

        tree, *forms = self._multiview_form.widget_groups[
            self._multiview_group]
        for widget in forms:
            if not widget.screen.current_record:
                continue
            if not widget._validate(set_value=False):
                def go_previous():
                    self.current_record = widget.screen.current_record
                    self.display()
                GLib.idle_add(go_previous)
                return False
        return True

    def _sync_group(self):
        if not self._multiview_form or self.current_view.view_type != 'tree':
            return
        if self.current_record is None:
            return

        to_sync = []
        tree, *forms = self._multiview_form.widget_groups[
            self._multiview_group]
        for widget in forms:
            if widget.screen.current_view.view_type != 'form':
                continue
            # TODO Useless now
            if (widget.screen.group.model_name !=
                    self.current_record.group.model_name):
                continue
            to_sync.append(widget)

        for widget in to_sync:
            widget.screen.current_record = self.current_record
            widget.display()

    def _update_resources(self, record):
        if (record
                and record == self.current_record
                and self.has_update_resources()):
            self.update_resources(record.get_resources())
        return False

    def destroy(self):
        self.windows.clear()
        for view in self.views:
            view.destroy()
        del self.views[:]
        self.group.destroy()

    def default_row_activate(self):
        if (self.current_view
                and self.current_view.view_type == 'tree'
                and int(self.current_view.attributes.get('keyword_open', 0))):
            return Action.exec_keyword('tree_open', {
                'model': self.model_name,
                'id': self.current_record.id if self.current_record else None,
                'ids': [r.id for r in self.selected_records],
                }, context=self.local_context, warning=False)
        else:
            if not self.modified():
                self.switch_view(view_type='form')
            return True

    @property
    def number_of_views(self):
        return len(self.views) + len(self.view_to_load)

    @property
    def view_index(self):
        return self.__current_view

    def switch_view(
            self, view_type=None, view_id=None, creatable=None, display=True):
        if view_id is not None:
            view_id = int(view_id)
        if self.current_view:
            self.current_view.set_value()
            if (self.current_record
                    and self.current_record not in self.current_record.group):
                self.current_record = None
            fields = self.current_view.get_fields()
            if (self.current_record and self.current_view.editable
                    and not self.current_record.validate(fields)):
                self.screen_container.set(self.current_view.widget)
                self.set_cursor()
                self.current_view.display()
                return

        def found():
            if not self.current_view:
                return False
            result = True
            if view_type is not None:
                result &= self.current_view.view_type == view_type
            if view_id is not None:
                result &= self.current_view.view_id == view_id
            if creatable is not None:
                result &= self.current_view.creatable == creatable
            return result
        for i in range(len(self.views) + len(self.view_to_load)):
            if len(self.view_to_load):
                self.load_view_to_load()
                self.__current_view = len(self.views) - 1
            elif (view_id is not None
                    and view_id not in {v.view_id for v in self.views}):
                self.add_view_id(view_id, view_type)
                self.__current_view = len(self.views) - 1
                break
            else:
                self.__current_view = ((self.__current_view + 1)
                        % len(self.views))
            if found():
                break
        self.screen_container.set(self.current_view.widget)
        if display:
            self.display()
            # Postpone set of the cursor to ensure widgets are allocated
            GLib.idle_add(self.set_cursor)

    def load_view_to_load(self):
        if len(self.view_to_load):
            if self.view_ids:
                view_id = self.view_ids.pop(0)
            else:
                view_id = None
            view_type = self.view_to_load.pop(0)
            self.add_view_id(view_id, view_type)

    def add_view_id(self, view_id, view_type):
        if view_id and str(view_id) in self.views_preload:
            view = self.views_preload[str(view_id)]
        elif not view_id and view_type in self.views_preload:
            view = self.views_preload[view_type]
        else:
            context = self.context
            context['view_tree_width'] = CONFIG['client.save_tree_width']
            context['user_agent'] = 'tryton'
            context['screen_size'] = get_monitor_size()
            try:
                view = RPCExecute(
                    'model', self.model_name, 'fields_view_get', view_id,
                    view_type, context=context)
            except RPCException:
                return
        return self.add_view(view)

    def add_view(self, view):
        arch = view['arch']
        fields = view['fields']
        view_id = view['view_id']

        xml_dom = xml.dom.minidom.parseString(arch)
        root, = xml_dom.childNodes
        if root.tagName == 'tree':
            self.fields_view_tree[view_id] = view

        # Ensure that loading is always lazy for fields on form view
        # and always eager for fields on tree or graph view
        if root.tagName == 'form':
            loading = 'lazy'
        else:
            loading = 'eager'
        for field in fields:
            if field not in self.group.fields or loading == 'eager':
                fields[field]['loading'] = loading
            else:
                fields[field]['loading'] = \
                    self.group.fields[field].attrs['loading']
        self.group.add_fields(fields)
        for field in fields:
            self.group.fields[field].views.add(view_id)
        view = View.parse(
            self, view_id, view['type'], xml_dom, view.get('field_childs'),
            view.get('children_definitions'))
        self.views.append(view)

        return view

    def editable_open_get(self):
        if (self.current_view and self.current_view.view_type == 'tree'
                and self.current_view.attributes.get('editable_open')):
            return self.current_view.widget_tree.editable_open
        return False

    def new(self, default=True, defaults=None):
        previous_view = self.current_view
        if self.current_view and self.current_view.view_type == 'calendar':
            selected_date = self.current_view.get_selected_date()
        if self.current_view and not self.current_view.creatable:
            self.switch_view(creatable=True, display=False)
            if not self.current_view.creatable:
                return None
        if self.current_record:
            group = self.current_record.group
        else:
            group = self.group
        self.current_record = None
        record = group.new(default, defaults=defaults)
        group.add(record, self.new_position)
        if previous_view.view_type == 'calendar':
            previous_view.set_default_date(record, selected_date)
        self.current_record = record
        self.display()
        # Postpone set of the cursor to ensure widgets are allocated
        GLib.idle_add(self.set_cursor, True)
        return self.current_record

    @property
    def new_position(self):
        if self.order is not None:
            order = self.order
        else:
            order = self.default_order
        if order:
            for oexpr, otype in order:
                if oexpr == 'id' and otype:
                    if otype.startswith('DESC'):
                        return 0
                    elif otype.startswith('ASC'):
                        return -1
        if self.parent:
            return -1
        else:
            return 0

    def set_on_write(self, func_name):
        if func_name:
            self.group.on_write.add(func_name)

    def cancel_current(self, initial_value=None):
        if self.current_record:
            self.current_record.cancel()
            if self.current_record.id < 0:
                if initial_value is not None:
                    self.current_record.reset(initial_value)
                else:
                    self.remove(records=[self.current_record])

    def save_current(self):
        if not self.current_record:
            if (self.current_view
                    and self.current_view.view_type == 'tree'
                    and len(self.group)):
                self.current_record = self.group[0]
            else:
                return True
        saved = False
        record_id = None
        if self.current_view:
            self.current_view.set_value()
            fields = self.current_view.get_fields()
        path = self.current_record.get_path(self.group)
        if self.current_view and self.current_view.view_type == 'tree':
            # False value must be not saved
            saved = all((
                    x is not False and x >= 0
                    for x in self.group.save()))
            record_id = self.current_record.id if self.current_record else None
        elif self.current_record.validate(fields):
            record_id = self.current_record.save(force_reload=True)
            # False value must be not saved
            saved = record_id is not False and record_id >= 0
        elif self.current_view:
            self.set_cursor()
            self.current_view.display()
            return False
        if path and record_id:
            path = path[:-1] + ((path[-1][0], record_id),)
        self.current_record = self.group.get_by_path(path)
        self.display()
        self.record_saved()
        return saved

    def __get_current_view(self):
        if not len(self.views):
            return None
        return self.views[self.__current_view]

    current_view = property(__get_current_view)

    def set_cursor(self, new=False, reset_view=True):
        current_view = self.current_view
        if not current_view:
            return
        elif current_view.view_type in ('tree', 'form', 'list-form'):
            current_view.set_cursor(new=new, reset_view=reset_view)

    def get(self):
        if not self.current_record:
            return None
        if self.current_view:
            self.current_view.set_value()
        return self.current_record.get()

    def get_on_change_value(self):
        if not self.current_record:
            return None
        if self.current_view:
            self.current_view.set_value()
        return self.current_record.get_on_change_value()

    def modified(self):
        if self.current_view and self.current_view.view_type != 'tree':
            if self.current_record:
                if self.current_record.modified or self.current_record.id < 0:
                    return True
        else:
            for record in self.group:
                if record.modified or record.id < 0:
                    return True
        if self.current_view and self.current_view.modified:
            return True
        return False

    def reload(self, ids, written=False):
        self.group.reload(ids)
        if written:
            self.group.written(ids)
        if self.parent:
            self.parent.root_parent.reload()
        record_id = self.current_record.id if self.current_record else None
        if self._multiview_form:
            root_parent = self.current_record.root_parent
            assert root_parent.model_name \
                == self._multiview_form.screen.model_name, (
                    root_parent.model_name, 'is not',
                    self._multiview_form.screen.model_name)
            self._multiview_form.screen.reload([root_parent.id])
        self.display()

    def unremove(self):
        records = self.selected_records
        for record in records:
            self.group.unremove(record)

    def remove(self, delete=False, remove=False, force_remove=False,
            records=None):
        records = list(reversed(records or self.selected_records))
        if not records:
            return
        if delete:
            # Must delete children records before parent
            records.sort(key=lambda r: r.depth, reverse=True)
            if not self.group.delete(records):
                return False

        for record in records:
            # set current model to None to prevent __select_changed
            # to save the previous_model as it can be already deleted.
            self.current_record = None
            record.group.remove(
                record, remove=remove, modified=False,
                force_remove=force_remove)
        # call only once
        record.set_modified()

        if delete:
            for record in records:
                if record in record.group.record_deleted:
                    record.group.record_deleted.remove(record)
                if record in record.group.record_removed:
                    record.group.record_removed.remove(record)
                if record.parent:
                    # Save parent without deleted children
                    record.parent.save(force_reload=False)
                record.destroy()

        self.current_record = None
        self.set_cursor()
        self.display()
        return True

    def copy(self):
        ids = [r.id for r in self.selected_records]
        try:
            new_ids = RPCExecute('model', self.model_name, 'copy', ids, {},
                context=self.context)
        except RPCException:
            return False
        self.group.load(new_ids, position=self.new_position)
        if new_ids:
            self.current_record = self.group.get(new_ids[0])
        self.display(set_cursor=True)
        return True

    def set_tree_state(self):
        view = self.current_view
        if not view:
            return
        if view.view_type not in {'tree', 'form', 'list-form'}:
            return
        if id(view) in self.tree_states_done:
            return
        if view.view_type == 'form' and self.tree_states_done:
            return
        if (view.view_type in {'tree', 'list-form'}
                and not int(view.attributes.get('tree_state', False))):
            # Mark as done to not set later when the view_type change
            self.tree_states_done.add(id(view))
        parent = self.parent.id if self.parent else None
        if parent is not None and parent < 0:
            # Allow expanding tree views in pure ModelViews
            if view.view_type == 'tree' and view.always_expand:
                view.expand_nodes(None)
            return
        expanded_nodes, selected_nodes = [], []
        if view.view_type in {'tree', 'list-form'}:
            state = self.tree_states[parent][view.children_field]
            if state:
                expanded_nodes, selected_nodes = state
            if (state is None
                    and CONFIG['client.save_tree_state']
                    and int(view.attributes.get('tree_state', False))
                    and (view.view_type != 'tree' or not view.always_expand)):
                json_domain = self.get_tree_domain(parent)
                try:
                    expanded_nodes, selected_nodes = RPCExecute('model',
                        'ir.ui.view_tree_state', 'get',
                        self.model_name, json_domain,
                        view.children_field)
                    expanded_nodes = json.loads(expanded_nodes)
                    selected_nodes = json.loads(selected_nodes)
                except RPCException:
                    logger.warn(
                        'Unable to get view tree state for %s',
                        self.model_name)
                self.tree_states[parent][view.children_field] = (
                    expanded_nodes, selected_nodes)
            if view.view_type == 'tree':
                view.expand_nodes(expanded_nodes)
            view.select_nodes(selected_nodes)
        else:
            if selected_nodes:
                record = None
                for node in selected_nodes[0]:
                    new_record = self.group.get(node)
                    if node < 0 and -node < len(self.group):
                        # Negative id is the index of the new record
                        new_record = self.group[-node]
                    if not new_record:
                        break
                    else:
                        record = new_record
                if record and record != self.current_record:
                    self.current_record = record
                    # Force a display of the view to synchronize the
                    # widgets with the new record
                    view.display()
        self.tree_states_done.add(id(view))

    def save_tree_state(self, store=True):
        parent = self.parent.id if self.parent else None
        for view in self.views:
            if view.view_type == 'form':
                for widgets in view.widgets.values():
                    for widget in widgets:
                        if hasattr(widget, 'screen'):
                            widget.screen.save_tree_state(store)
                if len(self.views) == 1 and self.current_record:
                    path = self.current_record.id
                    if path < 0:
                        path = -self.current_record.group.index(
                            self.current_record)
                    self.tree_states[parent][view.children_field] = (
                        [], [[path]])
            elif view.view_type in {'tree', 'list-form'}:
                if view.view_type == 'tree':
                    view.save_width()
                    paths = view.get_expanded_paths()
                else:
                    paths = []
                selected_paths = view.get_selected_paths()
                self.tree_states[parent][view.children_field] = (
                    paths, selected_paths)
                if (store
                        and int(view.attributes.get('tree_state', False))
                        and CONFIG['client.save_tree_state']):
                    json_domain = self.get_tree_domain(parent)
                    json_paths = json.dumps(paths, separators=(',', ':'))
                    json_selected_path = json.dumps(
                        selected_paths, separators=(',', ':'))
                    try:
                        RPCExecute('model', 'ir.ui.view_tree_state', 'set',
                            self.model_name, json_domain, view.children_field,
                            json_paths, json_selected_path,
                            process_exception=False)
                        clear_cache('model.ir.ui.view_tree_state.get')
                    except RPCException:
                        logger.warn(
                            _('Unable to set view tree state'), exc_info=True)

    def get_tree_domain(self, parent):
        if parent:
            domain = (self.domain + [(self.exclude_field, '=', parent)])
        else:
            domain = self.domain
        json_domain = json.dumps(
            domain, cls=JSONEncoder, separators=(',', ':'))
        return json_domain

    def load(self, ids, set_cursor=True, modified=False, position=-1):
        self.group.load(ids, modified=modified, position=position)
        if self.current_view:
            self.current_view.reset()
        self.current_record = None
        self.display(set_cursor=set_cursor)

    def display(self, set_cursor=False):
        if self.views and self.current_view:
            self.search_active(self.current_view.view_type
                in ('tree', 'graph', 'calendar'))
            for view in self.views:
                # Always display tree view to update model
                # because view can be used even if it is not shown
                # like for save_tree_state
                if (view == self.current_view
                        or view.view_type == 'tree'
                        or view.widget.get_parent()):
                    view.display()

            self.current_view.widget.set_sensitive(
                bool(self.group
                    or (self.current_view.view_type != 'form')
                    or self.current_record))
            if self.current_view.view_type == 'tree':
                view_tree = self.fields_view_tree.get(
                    self.current_view.view_id, {})
                if 'active' in view_tree['fields']:
                    self.screen_container.but_active.show()
                else:
                    self.screen_container.but_active.hide()
            else:
                self.screen_container.but_active.hide()
            if set_cursor:
                self.set_cursor(reset_view=False)
        self.set_tree_state()
        # Force record_message
        self.current_record = self.current_record

    def _get_next_record(self, test=False):
        view = self.current_view
        if (view
                and view.view_type in {'tree', 'form'}
                and self.current_record
                and self.current_record.group):
            group = self.current_record.group
            record = self.current_record
            while group:
                children = record.children_group(view.children_field,
                    view.children_definitions)
                if children:
                    record = children[0]
                    break
                idx = group.index(record) + 1
                if idx < len(group):
                    record = group[idx]
                    break
                parent = record.parent
                if not parent or record.model_name != parent.model_name:
                    break
                next = parent.next.get(id(parent.group))
                while not next:
                    parent = parent.parent
                    if not parent:
                        break
                    next = parent.next.get(id(parent.group))
                if not next:
                    break
                record = next
                break
            return record
        elif (view
                and view.view_type == 'list-form'
                and len(self.group)
                and self.current_record in self.group):
            idx = self.group.index(self.current_record)
            if 0 <= idx < len(self.group) - 1:
                return self.group[idx + 1]
        elif view and view.view_type == 'calendar':
            record = self.current_record
            goocalendar = view.widgets.get('goocalendar')
            if goocalendar:
                date = goocalendar.selected_date
                year = date.year
                month = date.month
                start = datetime.datetime(year, month, 1)
                nb_days = calendar.monthrange(year, month)[1]
                delta = datetime.timedelta(days=nb_days)
                end = start + delta
                events = goocalendar.event_store.get_events(start, end)
                events.sort()
                if not record:
                    if events:
                        return events[0].record
                    else:
                        return
                else:
                    for idx, event in enumerate(events):
                        if event.record == record:
                            next_id = idx + 1
                            if next_id < len(events):
                                return events[next_id].record
                            break
        else:
            return self.group[0] if len(self.group) else None

    def has_next(self):
        next_record = self._get_next_record(test=True)
        return next_record and next_record != self.current_record

    def display_next(self):
        view = self.current_view
        if view:
            view.set_value()
        self.set_cursor(reset_view=False)
        self.current_record = self._get_next_record()
        self.set_cursor(reset_view=False)
        if view:
            view.display()

    def _get_prev_record(self, test=False):
        view = self.current_view
        if (view
                and view.view_type in {'tree', 'form'}
                and self.current_record
                and self.current_record.group):
            group = self.current_record.group
            record = self.current_record
            idx = group.index(record) - 1
            if idx >= 0:
                record = group[idx]
                children = True
                while children:
                    children = record.children_group(view.children_field,
                        view.children_definitions)
                    if children:
                        record = children[-1]
            else:
                parent = record.parent
                if parent and record.model_name == parent.model_name:
                    record = parent
            return record
        elif view and view.view_type == 'calendar':
            record = self.current_record
            goocalendar = view.widgets.get('goocalendar')
            if goocalendar:
                date = goocalendar.selected_date
                year = date.year
                month = date.month
                start = datetime.datetime(year, month, 1)
                nb_days = calendar.monthrange(year, month)[1]
                delta = datetime.timedelta(days=nb_days)
                end = start + delta
                events = goocalendar.event_store.get_events(start, end)
                events.sort()
                if not record:
                    if events:
                        return events[0].record
                    else:
                        return
                else:
                    for idx, event in enumerate(events):
                        if event.record == record:
                            prev_id = idx - 1
                            if prev_id >= 0:
                                return events[prev_id].record
                            break
        elif (view
                and view.view_type == 'list-form'
                and len(self.group)
                and self.current_record in self.group):
            idx = self.group.index(self.current_record)
            if 0 < idx <= len(self.group) - 1:
                return self.group[idx - 1]
        else:
            return self.group[-1] if len(self.group) else None

    def has_prev(self):
        prev_record = self._get_prev_record(test=True)
        return prev_record and prev_record != self.current_record

    def display_prev(self):
        view = self.current_view
        if view:
            view.set_value()
        self.set_cursor(reset_view=False)
        self.current_record = self._get_prev_record()
        self.set_cursor(reset_view=False)
        if view:
            view.display()

    def invalid_message(self, record=None):
        if record is None:
            record = self.current_record
        domain_string = _('"%s" is not valid according to its domain.')
        domain_parser = DomainParser(
            {n: f.attrs for n, f in record.group.fields.items()})
        fields = []
        for field, invalid in sorted(record.invalid_fields.items()):
            string = record.group.fields[field].attrs['string']
            if invalid == 'required' or invalid == [[field, '!=', None]]:
                fields.append(_('"%s" is required.') % string)
            elif invalid == 'domain':
                fields.append(domain_string % string)
            elif invalid == 'children':
                fields.append(_('The values of "%s" are not valid.') % string)
            elif invalid == 'value':
                fields.append(_('The value of "%s" is not valid.') % string)
            else:
                if domain_parser.stringable(invalid):
                    fields.append(domain_parser.string(invalid))
                else:
                    fields.append(domain_string % string)
        if len(fields) > 5:
            fields = fields[:5] + ['...']
        return '\n'.join(fields)

    @property
    def selected_records(self):
        return self.current_view.selected_records if self.current_view else []

    @property
    def selected_paths(self):
        if self.current_view and self.current_view.view_type == 'tree':
            return self.current_view.get_selected_paths()
        else:
            return []

    @property
    def listed_records(self):
        if (self.current_view
                and self.current_view.view_type in {
                    'tree', 'calendar', 'list-form'}):
            return self.current_view.listed_records
        elif self.current_record:
            return [self.current_record]
        else:
            return []

    @property
    def listed_paths(self):
        if self.current_view and self.current_view.view_type == 'tree':
            return self.current_view.get_listed_paths()

    def clear(self):
        self.current_record = None
        self.group.clear()
        self.tree_states_done.clear()
        for view in self.views:
            view.reset()

    def on_change(self, fieldname, attr):
        self.current_record.on_change(fieldname, attr)
        self.display()

    def get_buttons(self):
        'Return active buttons for the current view'
        def is_active(record, button):
            if button.attrs.get('type', 'class') == 'instance':
                return False
            states = record.expr_eval(button.attrs.get('states', {}))
            return not (states.get('invisible') or states.get('readonly'))

        if not self.selected_records:
            return []

        buttons = self.current_view.get_buttons() if self.current_view else []

        for record in self.selected_records:
            buttons = [b for b in buttons if is_active(record, b)]
            if not buttons:
                break
        return buttons

    def button(self, button):
        'Execute button on the selected records'
        if self.current_view:
            self.current_view.set_value()
            fields = self.current_view.get_fields()
        if button.get('type') != 'client_action':
            fields = self.current_view.get_fields()
            for record in self.selected_records:
                domain = record.expr_eval(
                    button.get('states', {})).get('pre_validate', [])
                if not record.validate(fields, pre_validate=domain):
                    warning(self.invalid_message(record), _('Pre-validation'))
                    self.display(set_cursor=True)
                    if domain:
                        # Reset valid state with normal domain
                        record.validate(fields)
                    return
        if button.get('confirm', False) and not sur(button['confirm']):
            return
        if button.get('type', 'class') == 'class':
            record_id = self.current_record.save(force_reload=False)
            if record_id is False or record_id < 0:
                return
            self._button_class(button)
        elif button.get('type') == 'instance':
            self._button_instance(button)
        else:
            self._button_client_action(button)

    def _button_instance(self, button):
        record = self.current_record
        args = record.expr_eval(button.get('change', []))
        values = record._get_on_change_args(args)
        try:
            changes = RPCExecute('model', self.model_name, button['name'],
                values, context=self.context)
        except RPCException:
            return
        record.set_on_change(changes)
        record.set_modified()

    def _button_class(self, button):
        ids = [r.id for r in self.selected_records]
        current_id = self.current_record.id
        context = self.context
        context['_timestamp'] = {}
        for record in self.selected_records:
            context['_timestamp'].update(record.get_timestamp())
        try:
            action = RPCExecute('model', self.model_name, button['name'],
                ids, context=context)
        except RPCException:
            action = None
        self.reload(ids, written=True)
        self.record_saved()
        # PJA: handle different returns values from button
        if isinstance(action, list):
            for act in action:
                if isinstance(act, str):
                    self.client_action(act)
                elif act:
                    Action.execute(act, {
                            'model': self.model_name,
                            'id': current_id,
                            'ids': ids,
                            }, context=self.context, keyword=True)
        elif isinstance(action, str):
            self.client_action(action)
        elif action:
            Action.execute(action, {
                    'model': self.model_name,
                    'id': current_id,
                    'ids': ids,
                    }, context=self.context, keyword=True)

    def _button_client_action(self, button):
        self.client_action(button['name'])

    def client_action(self, action):
        access = MODELACCESS[self.model_name]
        # Coog : Allow multiple actions (review 10530001)
        for single_action in action.split(','):
            self.do_single_action(single_action, access)

    def do_single_action(self, action, access):
        if action == 'new':
            if access['create']:
                self.new()
        elif action == 'delete':
            if (access['delete']
                    and (self.current_record.deletable
                        if self.current_record else True)):
                self.remove(delete=not self.parent,
                    force_remove=not self.parent)
        elif action == 'remove':
            if access['write'] and access['read'] and self.parent:
                self.remove(remove=True)
        elif action == 'copy':
            if access['create']:
                self.copy()
        elif action == 'next':
            self.display_next()
        elif action == 'previous':
            self.display_prev()
        elif action == 'close':
            from tryton.gui import Main
            main = Main()
            for page in main.pages:
                if page.screen is self:
                    break
            else:
                page = None
            main.sig_win_close(page_widget=page.widget if page else None)
        elif action.startswith('switch'):
            self.switch_view(*action.split(None, 2)[1:])
        elif action == 'reload':
            if (self.current_view
                    and self.current_view.view_type in [
                        'tree', 'graph', 'calendar']
                    and not self.parent):
                self.search_filter()
        elif action == 'reload menu':
            from tryton.gui import Main
            RPCContextReload(Main().sig_win_menu)
        elif action == 'reload context':
            RPCContextReload()
        elif action == 'refresh parent':
            if self.parent_screen:
                domain_txt = self.parent_screen.screen_container.get_text()
                self.parent_screen.search_filter(domain_txt)

    def get_url(self, name=''):
        query_string = []
        if self.domain:
            query_string.append(('domain', json.dumps(
                        self.domain, cls=JSONEncoder, separators=(',', ':'))))
        context = self.local_context  # Avoid rpc context
        if context:
            query_string.append(('context', json.dumps(
                        context, cls=JSONEncoder, separators=(',', ':'))))
        if self.context_screen:
            query_string.append(
                ('context_model', self.context_screen.model_name))
        if name:
            query_string.append(
                ('name', json.dumps(name, separators=(',', ':'))))
        path = [CONFIG['login.db'], 'model', self.model_name]
        view_ids = [v.view_id for v in self.views] + self.view_ids
        if self.current_view and self.current_view.view_type != 'form':
            if self.screen_container.tab_domain:
                query_string.append(('tab_domain', json.dumps(
                            self.screen_container.tab_domain,
                            cls=JSONEncoder, separators=(',', ':'))))
            if self.search_value:
                search_value = self.search_value
            else:
                search_string = self.screen_container.get_text()
                search_value = self.domain_parser.parse(search_string)
            if search_value:
                query_string.append(('search_value', json.dumps(
                            search_value, cls=JSONEncoder,
                            separators=(',', ':'))))
        elif self.current_record and self.current_record.id > -1:
            path.append(str(self.current_record.id))
            if self.current_view:
                i = view_ids.index(self.current_view.view_id)
                view_ids = view_ids[i:] + view_ids[:i]
        if view_ids:
            query_string.append(('views', json.dumps(
                        view_ids, separators=(',', ':'))))
        query_string = urllib.parse.urlencode(query_string)
        return urllib.parse.urlunparse(('tryton',
                CONFIG['login.host'],
                '/'.join(path), query_string, '', ''))

    def _force_count(self, search_string):
        domain = self.search_domain(search_string, True)
        context = self.context
        if self.screen_container.but_active.get_active():
            context['active_test'] = False
        self.search_count = RPCExecute(
            'model', self.model_name, 'search_count', domain, context=context)
        self.record_message(
            self.position, len(self.group) + self.offset,
            self.search_count, self.current_record and self.current_record.id)

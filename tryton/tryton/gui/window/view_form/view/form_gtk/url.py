#This file is part of Tryton.  The COPYRIGHT file at the top level of this repository contains the full copyright notices and license terms.
import gettext
import gtk
from char import Char
import webbrowser


class URL(Char):
    "url"

    def __init__(self, window, parent, model, attrs=None):
        if attrs is None:
            attrs = {}
        super(URL, self).__init__(window, parent, model, attrs=attrs)

        self.tooltips = gtk.Tooltips()
        self.button = gtk.Button()
        img = gtk.Image()
        img.set_from_stock('tryton-web-browser', gtk.ICON_SIZE_SMALL_TOOLBAR)
        self.button.set_image(img)
        self.button.set_relief(gtk.RELIEF_NONE)
        self.button.connect('clicked', self.button_clicked)
        self.button.set_alignment(0.5, 0.5)
        self.widget.pack_start(self.button, expand=False, fill=False)
        self.widget.set_focus_chain([self.entry])

    def display(self, model, model_field):
        super(URL, self).display(model, model_field)
        self.set_tooltips()

    def set_tooltips(self):
        value = self.entry.get_text()
        if value:
            self.tooltips.enable()
            self.tooltips.set_tip(self.button, value)
        else:
            self.tooltips.disable()

    def _readonly_set(self, value):
        super(URL, self)._readonly_set(value)
        if value:
            self.entry.hide()
            self.widget.set_focus_chain([self.button])
        else:
            self.entry.show()
            self.widget.set_focus_chain([self.entry])

    def button_clicked(self, widget):
        value = self.entry.get_text()
        if value:
            webbrowser.open(value, new=2)


class Email(URL):
    "email"

    def button_clicked(self, widget):
        value = self.entry.get_text()
        if value:
            webbrowser.open('mailto:%s' % value, new=2)

    def set_tooltips(self):
        value = self.entry.get_text()
        if value:
            self.tooltips.enable()
            self.tooltips.set_tip(self.button, 'mailto:%s' % value)
        else:
            self.tooltips.disable()


class CallTo(URL):
    "call to"

    def button_clicked(self, widget):
        value = self.entry.get_text()
        if value:
            webbrowser.open('callto:%s' % value, new=2)

    def set_tooltips(self):
        value = self.entry.get_text()
        if value:
            self.tooltips.enable()
            self.tooltips.set_tip(self.button, 'callto:%s' % value)
        else:
            self.tooltips.disable()


class SIP(URL):
    "sip"

    def button_clicked(self, widget):
        value = self.entry.get_text()
        if value:
            webbrowser.open('sip:%s' % value, new=2)

    def set_tooltips(self):
        value = self.entry.get_text()
        if value:
            self.tooltips.enable()
            self.tooltips.set_tip(self.button, 'sip:%s' % value)
        else:
            self.tooltips.disable()


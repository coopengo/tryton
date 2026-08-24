# This file is part of Tryton.  The COPYRIGHT file at the top level of
# this repository contains the full copyright notices and license terms.

import trytond.config as config
from trytond.cache import Cache
from trytond.model import ModelSingleton, ModelSQL, fields
from trytond.transaction import Transaction


class Configuration(ModelSingleton, ModelSQL):
    __name__ = 'ir.configuration'
    series = fields.Char("Series")
    language = fields.Char('language')
    hostname = fields.Char("Hostname", strip=False)
    production = fields.Boolean("Production")
    _get_language_cache = Cache('ir_configuration.get_language')

    @classmethod
    def __register__(cls, module):
        table = cls.__table__()
        table_h = cls.__table_handler__(module)
        has_production = table_h.column_exist('production')

        super().__register__(module)

        # Migration from 8.0
        if not has_production:
            cursor = Transaction().connection.cursor()
            cursor.execute(*table.update([table.production], [True]))

    @staticmethod
    def default_language():
        return config.get('database', 'language')

    @classmethod
    def get_language(cls):
        language = cls._get_language_cache.get(None)
        if language is not None:
            return language
        language = cls(1).language
        if not language:
            language = config.get('database', 'language')
        return cls._get_language_cache.set(None, language)

    def check(self):
        "Check configuration coherence on pool initialisation"
        pass

    @classmethod
    def on_modification(cls, mode, records, field_names=None):
        super().on_modification(mode, records, field_names=field_names)
        cls._get_language_cache.clear()

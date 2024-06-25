# This file is part of Tryton.  The COPYRIGHT file at the top level of
# this repository contains the full copyright notices and license terms.
from trytond import backend

from trytond.cache import Cache
from trytond.config import config
from trytond.model import ModelSingleton, ModelSQL, fields
from trytond.transaction import Transaction


class Configuration(ModelSingleton, ModelSQL):
    'Configuration'
    __name__ = 'ir.configuration'
    language = fields.Char('language')
    hostname = fields.Char("Hostname", strip=False)
    _get_language_cache = Cache('ir_configuration.get_language')

    @classmethod
    def __register__(cls, module_name):
        # This migration must be done before any translation creation takes
        # place
        if backend.name != 'sqlite':
            cursor = Transaction().connection.cursor()
            cursor.execute(
                "ALTER TABLE ir_translation ALTER COLUMN res_id DROP NOT NULL")
        super().__register__(module_name)

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
        cls._get_language_cache.set(None, language)
        return language

    def check(self):
        "Check configuration coherence on pool initialisation"
        pass

    @classmethod
    def create(cls, vlist):
        records = super().create(vlist)
        cls._get_language_cache.clear()
        return records

    @classmethod
    def write(cls, *args):
        super().write(*args)
        cls._get_language_cache.clear()

    @classmethod
    def delete(cls, records):
        super().delete(records)
        cls._get_language_cache.clear()

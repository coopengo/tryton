# This file is part of Tryton.  The COPYRIGHT file at the top level of
# this repository contains the full copyright notices and license terms.
from sql import Table

from trytond import backend
from trytond.transaction import Transaction


class MaterializedViewMixin:
    pass


def materialize():
    if backend.Database.has_materialized_views():
        class MaterializedImpl(MaterializedViewMixin):
            "Mixin to materialize table_query models"
            _update_interval = 1440  # one day

            @classmethod
            def __setup__(cls):
                from .modelsql import Index

                super().__setup__()

                table = cls.__table__()
                cls._sql_indexes.add(
                    Index(table, (table.id, Index.Range()), unique=True)
                    )

            @classmethod
            def __register__(cls, module_name):
                transaction = Transaction()
                transaction.database.create_materialized_views(
                    transaction.connection, cls._table, cls.table_query())

            @classmethod
            def refresh_view(cls):
                transaction = Transaction()
                transaction.database.refresh_materialized_view(
                    transaction.connection, cls._table)

            @classmethod
            def __table__(cls):
                return Table(cls._table)
    else:
        class MaterializedImpl:
            pass

    return MaterializedImpl

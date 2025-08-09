# This file is part of Tryton.  The COPYRIGHT file at the top level of
# this repository contains the full copyright notices and license terms.

from collections import defaultdict
from itertools import groupby
from operator import itemgetter

from trytond.filestore import filestore
from trytond.model import ModelSQL, fields
from trytond.pool import Pool
from trytond.transaction import Transaction


class RemovedFile(ModelSQL):
    "Removed File"
    __name__ = 'ir.removed_file'

    file_id = fields.Char("File ID", required=True)
    model = fields.Char("Model", required=True)
    field = fields.Char("Field", required=True)

    @classmethod
    def remove(cls):
        pool = Pool()

        table = cls.__table__()
        transaction = Transaction()
        cursor = transaction.connection.cursor()
        cursor.execute(*table.select(
                table.file_id, table.model, table.field,
                order_by=[table.model, table.field]))

        to_remove = defaultdict(list)
        for (model, fname), deleted in groupby(cursor, key=itemgetter(1, 2)):
            Model = pool.get(model)
            field = Model._fields[fname]
            prefix = field.store_prefix
            if prefix is None:
                prefix = transaction.database.name

            deleted_ids = {d[0] for d in deleted}
            active_ids = {getattr(r, field.file_id) for r in Model.search([
                        (field.file_id, 'in', list(deleted_ids)),
                        ])}
            to_remove[prefix].extend(deleted_ids - active_ids)

        for store_prefix, to_delete in to_remove.items():
            filestore.delete_many(to_delete, prefix=store_prefix)

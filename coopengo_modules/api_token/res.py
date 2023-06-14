# This file is part of Coog. The COPYRIGHT file at the top level of
# this repository contains the full copyright notices and license terms.
from trytond.pool import PoolMeta

from trytond.model import fields

__all__ = [
    'User',
    ]


class User(metaclass=PoolMeta):
    __name__ = 'res.user'

    tokens = fields.One2Many('api.token', 'user', 'Tokens')

    @classmethod
    def _export_skips(cls):
        return super(UserWithApi, cls)._export_skips() | {'tokens'}

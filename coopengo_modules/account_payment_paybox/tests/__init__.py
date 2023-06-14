# This file is part of Coog. The COPYRIGHT file at the top level of
# this repository contains the full copyright notices and license terms.

try:
    from trytond.modules.account_payment_paybox.tests.test_account import suite
except ImportError:
    from .test_account import suite

__all__ = ['suite']

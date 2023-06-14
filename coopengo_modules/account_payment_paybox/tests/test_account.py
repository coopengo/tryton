# This file is part of Coog. The COPYRIGHT file at the top level of
# this repository contains the full copyright notices and license terms.
import unittest
try:
    import phonenumbers
except ImportError:
    phonenumbers = None

import trytond.tests.test_tryton
from trytond.tests.test_tryton import ModuleTestCase


class AccountTestCase(ModuleTestCase):
    'Test Account Payment Paybox module'
    module = 'account_payment_paybox'


def suite():
    suite = trytond.tests.test_tryton.suite()
    suite.addTests(unittest.TestLoader().loadTestsFromTestCase(
            AccountTestCase))
    return suite

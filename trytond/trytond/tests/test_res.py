# This file is part of Tryton.  The COPYRIGHT file at the top level of
# this repository contains the full copyright notices and license terms.
import unittest

from .test_tryton import ModuleTestCase


class ResTestCase(ModuleTestCase):
    'Test res module'
    module = 'res'

    @with_transaction()
    def test_user_warning(self):
        "Check user warning"
        pool = Pool()
        Warning_ = pool.get('res.user.warning')

        self.assertTrue(Warning_.check('test'))

    @with_transaction()
    def test_user_warning_ignored(self):
        "Check ignored user warning"
        pool = Pool()
        Warning_ = pool.get('res.user.warning')

        user_id = Transaction().user
        Warning_.create([{
                    'user': user_id,
                    'name': 'test',
                    }])

        self.assertFalse(Warning_.check('test'))
        self.assertFalse(Warning_.search([]))

    @with_transaction()
    def test_user_warning_always_ignored(self):
        "Check always ignored user warning"
        pool = Pool()
        Warning_ = pool.get('res.user.warning')

        user_id = Transaction().user
        Warning_.create([{
                    'user': user_id,
                    'name': 'test',
                    'always': True,
                    }])

        self.assertFalse(Warning_.check('test'))
        self.assertTrue(Warning_.search([]))

    @with_transaction()
    def test_user_warning_reentrant(self):
        "Check re-entrant user warning"
        pool = Pool()
        Warning_ = pool.get('res.user.warning')

        user_id = Transaction().user
        Warning_.create([{
                    'user': user_id,
                    'name': 'test',
                    }])

        self.assertFalse(Warning_.check('test'))
        self.assertFalse(Warning_.check('test'))


def suite():
    return unittest.TestLoader().loadTestsFromTestCase(ResTestCase)

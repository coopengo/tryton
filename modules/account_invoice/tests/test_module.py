# This file is part of Tryton.  The COPYRIGHT file at the top level of
# this repository contains the full copyright notices and license terms.

import datetime
from decimal import Decimal
from unittest.mock import MagicMock

from trytond.modules.account_invoice.exceptions import (
    PaymentTermValidationError)
from trytond.modules.company.tests import (
    CompanyTestMixin, PartyCompanyCheckEraseMixin)
from trytond.modules.currency.tests import create_currency
from trytond.pool import Pool
from trytond.tests.test_tryton import ModuleTestCase, with_transaction


def set_invoice_sequences(fiscalyear):
    pool = Pool()
    Sequence = pool.get('ir.sequence.strict')
    SequenceType = pool.get('ir.sequence.type')
    InvoiceSequence = pool.get('account.fiscalyear.invoice_sequence')

    sequence_type, = SequenceType.search([
            ('name', '=', "Invoice"),
            ], limit=1)
    sequence = Sequence(name=fiscalyear.name, sequence_type=sequence_type)
    sequence.company = fiscalyear.company
    sequence.save()
    fiscalyear.invoice_sequences = []
    invoice_sequence = InvoiceSequence()
    invoice_sequence.fiscalyear = fiscalyear
    invoice_sequence.in_invoice_sequence = sequence
    invoice_sequence.in_credit_note_sequence = sequence
    invoice_sequence.out_invoice_sequence = sequence
    invoice_sequence.out_credit_note_sequence = sequence
    invoice_sequence.save()
    return fiscalyear


class AccountInvoiceTestCase(
        PartyCompanyCheckEraseMixin, CompanyTestMixin, ModuleTestCase):
    'Test AccountInvoice module'
    module = 'account_invoice'

    @with_transaction()
    def test_payment_term(self):
        'Test payment_term'
        pool = Pool()
        PaymentTerm = pool.get('account.invoice.payment_term')

        cu1 = create_currency('cu1')
        term, = PaymentTerm.create([{
                    'name': '30 days, 1 month, 1 month + 15 days',
                    'lines': [
                        ('create', [{
                                    'sequence': 0,
                                    'type': 'percent',
                                    'divisor': 4,
                                    'ratio': Decimal('.25'),
                                    'relativedeltas': [('create', [{
                                                    'days': 30,
                                                    },
                                                ]),
                                        ],
                                    }, {
                                    'sequence': 1,
                                    'type': 'percent_on_total',
                                    'divisor': 4,
                                    'ratio': Decimal('.25'),
                                    'relativedeltas': [('create', [{
                                                    'months': 1,
                                                    },
                                                ]),
                                        ],
                                    }, {
                                    'sequence': 2,
                                    'type': 'fixed',
                                    'amount': Decimal('396.84'),
                                    'currency': cu1.id,
                                    'relativedeltas': [('create', [{
                                                    'months': 1,
                                                    'days': 30,
                                                    },
                                                ]),
                                        ],
                                    }, {
                                    'sequence': 3,
                                    'type': 'remainder',
                                    'relativedeltas': [('create', [{
                                                    'months': 2,
                                                    'days': 30,
                                                    'day': 15,
                                                    },
                                                ]),
                                        ],
                                    }])]
                    }])
        terms = term.compute(Decimal('1587.35'), cu1,
            date=datetime.date(2011, 10, 1))
        self.assertEqual(terms, [
                (datetime.date(2011, 10, 31), Decimal('396.84')),
                (datetime.date(2011, 11, 1), Decimal('396.84')),
                (datetime.date(2011, 12, 1), Decimal('396.84')),
                (datetime.date(2012, 1, 14), Decimal('396.83')),
                ])

    @with_transaction()
    def test_payment_term_with_repeating_decimal(self):
        "Test payment_term with repeating decimal"
        pool = Pool()
        PaymentTerm = pool.get('account.invoice.payment_term')

        PaymentTerm.create([{
                    'name': "Repeating Decimal",
                    'lines': [
                        ('create', [{
                                    'type': 'percent',
                                    'divisor': Decimal(3),
                                    'ratio': Decimal('0.3333333333'),
                                    }, {
                                    'type': 'remainder',
                                    }]),
                        ],
                    }])

    @with_transaction()
    def test_payment_term_with_invalid_ratio_divisor(self):
        "Test payment_term with invalid ratio and divisor"
        pool = Pool()
        PaymentTerm = pool.get('account.invoice.payment_term')

        with self.assertRaises(PaymentTermValidationError):
            PaymentTerm.create([{
                        'name': "Invalid ratio and divisor",
                        'lines': [
                            ('create', [{
                                        'type': 'percent',
                                        'divisor': Decimal(2),
                                        'ratio': Decimal('0.4'),
                                        }, {
                                        'type': 'remainder',
                                        }]),
                            ],
                        }])

    @with_transaction()
    def test_payment_term_with_empty_value(self):
        'Test payment_term with empty'
        pool = Pool()
        PaymentTerm = pool.get('account.invoice.payment_term')

        cu1 = create_currency('cu1')
        remainder_term, percent_term = PaymentTerm.create([{
                    'name': 'Remainder',
                    'lines': [
                        ('create', [{'type': 'remainder',
                                    'relativedeltas': [('create', [{
                                                    'months': 1,
                                                    },
                                                ]),
                                        ],
                                    }])]
                    }, {
                    'name': '25% tomorrow, remainder un month later ',
                    'lines': [
                        ('create', [{'type': 'percent',
                                    'divisor': 4,
                                    'ratio': Decimal('.25'),
                                    'relativedeltas': [('create', [{
                                                    'days': 1,
                                                    },
                                                ]),
                                        ],
                                    }, {'type': 'remainder',
                                    'relativedeltas': [('create', [{
                                                    'months': 1,
                                                    },
                                                ]),
                                        ],
                                    }])]
                    }])
        terms = remainder_term.compute(Decimal('0.0'), cu1,
            date=datetime.date(2016, 5, 17))
        self.assertEqual(terms, [
                (datetime.date(2016, 5, 17), Decimal('0.0')),
                ])
        terms = percent_term.compute(Decimal('0.0'), cu1,
            date=datetime.date(2016, 5, 17))
        self.assertEqual(terms, [
                (datetime.date(2016, 5, 17), Decimal('0.0')),
                ])

    @with_transaction()
    def test_negative_amount(self):
        'Test payment term with negative amount'
        pool = Pool()
        PaymentTerm = pool.get('account.invoice.payment_term')

        cu1 = create_currency('cu1')
        term, = PaymentTerm.create([{
                    'name': '30 days, 1 month, 1 month + 15 days',
                    'lines': [
                        ('create', [{
                                    'sequence': 0,
                                    'type': 'percent',
                                    'divisor': 4,
                                    'ratio': Decimal('.25'),
                                    'relativedeltas': [('create', [{
                                                    'days': 30,
                                                    },
                                                ]),
                                        ],
                                    }, {
                                    'sequence': 1,
                                    'type': 'percent_on_total',
                                    'divisor': 4,
                                    'ratio': Decimal('.25'),
                                    'relativedeltas': [('create', [{
                                                    'months': 1,
                                                    },
                                                ]),
                                        ],
                                    }, {
                                    'sequence': 2,
                                    'type': 'fixed',
                                    'amount': Decimal('4.0'),
                                    'currency': cu1.id,
                                    'relativedeltas': [('create', [{
                                                    'months': 1,
                                                    'days': 30,
                                                    },
                                                ]),
                                        ],
                                    }, {
                                    'sequence': 3,
                                    'type': 'remainder',
                                    'relativedeltas': [('create', [{
                                                    'months': 2,
                                                    'days': 30,
                                                    'day': 15,
                                                    },
                                                ]),
                                        ],
                                    }])]
                    }])
        terms = term.compute(Decimal('-10.00'), cu1,
            date=datetime.date(2011, 10, 1))
        self.assertListEqual(terms, [
                (datetime.date(2011, 10, 31), Decimal('-2.5')),
                (datetime.date(2011, 11, 1), Decimal('-2.5')),
                (datetime.date(2011, 12, 1), Decimal('-4.0')),
                (datetime.date(2012, 1, 14), Decimal('-1.0')),
                ])

    @staticmethod
    def make_line(
            debit, credit=0, second_currency=None,
            amount_second_currency=Decimal("0"), party="Customer A"):
        line = MagicMock()
        line.debit = Decimal(debit)
        line.credit = Decimal(credit)
        line.second_currency = second_currency
        line.amount_second_currency = Decimal(amount_second_currency)
        line.reconciliation = None
        line.party = party
        return line

    @with_transaction()
    def test_exact_match(self):
        Invoice = Pool().get("account.invoice")
        invoice = MagicMock(spec=Invoice)

        # Mock currencies
        currency = MagicMock()
        currency.is_zero.side_effect = lambda x: abs(x) < Decimal("0.0001")

        company = MagicMock()
        company.currency = currency

        account = MagicMock()
        account.party_required = False

        # Attach mocked attributes to invoice
        invoice.company = company
        invoice.currency = currency
        invoice.account = account
        invoice.party = "Customer A"

        # Create fake lines
        lines = [
            self.make_line(40),
            self.make_line(20),
            self.make_line(10),
            self.make_line(30),
            self.make_line(50),
            self.make_line(5),
        ]
        invoice.payment_lines = lines[:4]
        invoice.lines_to_pay = lines[4:]

        # Call the real method with mocked self
        result = Invoice.get_reconcile_lines_for_amount(
            invoice, Decimal("140"), currency)
        # Target amount is 140, so the closest combination should be
        # 40 + 20 + 30 + 50 = 140
        # Line 10 and Line 5 will be ignored
        self.assertEqual(
            set(l.debit for l in result.lines),
            {Decimal("20"), Decimal("40"), Decimal("30"), Decimal("50")})
        self.assertEqual(sum(
                l.debit - l.credit for l in result.lines), Decimal("140"))
        self.assertEqual(result.remainder, Decimal("0"))

    @with_transaction()
    def test_closest_match(self):
        Invoice = Pool().get("account.invoice")
        invoice = MagicMock(spec=Invoice)

        currency = MagicMock()
        currency.is_zero.side_effect = lambda x: abs(x) < Decimal("0.0001")

        company = MagicMock()
        company.currency = currency

        account = MagicMock()
        account.party_required = False

        invoice.company = company
        invoice.currency = currency
        invoice.account = account
        invoice.party = "Customer A"

        lines = [
            self.make_line(40),
            self.make_line(20),
            self.make_line(10),
            self.make_line(30),
            self.make_line(5),
        ]

        invoice.payment_lines = lines[:3]
        invoice.lines_to_pay = lines[3:]

        # Call the real method with mocked self
        result = Invoice.get_reconcile_lines_for_amount(
            invoice, Decimal("97"), currency)
        # Target amount is 97, so the closest combination should be
        # 40 + 20 + 30 + 5 = 95
        # Line 10 will be ignored
        self.assertEqual(
            set(l.debit for l in result.lines),
            {Decimal("20"), Decimal("40"), Decimal("30"), Decimal("5")})
        self.assertEqual(sum(
                l.debit - l.credit for l in result.lines), Decimal("95"))
        self.assertEqual(result.remainder, Decimal("-2"))


del ModuleTestCase

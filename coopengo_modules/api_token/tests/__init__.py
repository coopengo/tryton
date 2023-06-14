# This file is part of Coog. The COPYRIGHT file at the top level of
# this repository contains the full copyright notices and license terms.

try:
    from trytond.modules.api_token.tests.test_api_token import suite
except ImportError:
    from .test_api_token import suite

__all__ = ['suite']

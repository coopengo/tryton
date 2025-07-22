# This file is part of Tryton.  The COPYRIGHT file at the top level of
# this repository contains the full copyright notices and license terms.

import inspect
import os
import unittest

from proteus import Model, Wizard
from proteus import config as pconfig
from trytond.server_context import ServerContext, TEST_CONTEXT

from .test_tryton import backup_db_cache, drop_create, restore_db_cache

__all__ = ['activate_modules', 'set_user']


def _cache_name(modules):
    scenario_name = None
    for frame in inspect.stack():
        absolute_path, file_name = os.path.split(frame.filename)
        file_name = os.path.splitext(file_name)[0]
        if "scenario_" in file_name:
            scenario_name = file_name
            break
    if not scenario_name:
        return '-'.join(modules)
    module_path, _ = os.path.split(absolute_path)
    module_name = os.path.basename(module_path)
    return f'{module_name}-{scenario_name}'


# PKU add cache_file_name
def activate_modules(modules, *, setup_function=None, cache_file_name=None):
    if isinstance(modules, str):
        modules = [modules]
    cache_name = cache_file_name or _cache_name(modules)
    assert setup_function is None or callable(setup_function)
    if callable(setup_function):
        cache_name += f'-{setup_function.__qualname__}'
    if restore_db_cache(cache_name):
        return _get_config()
    drop_create()

    cfg = _get_config()
    Module = Model.get('ir.module')
    records = Module.find([
            ('name', 'in', modules),
            ])
    assert len(records) == len(modules)
    Module.click(records, 'activate')
    with ServerContext().set_context(**TEST_CONTEXT):
        Wizard('ir.module.activate_upgrade').execute('upgrade')

    if callable(setup_function):
        setup_function(cfg)
    backup_db_cache(cache_name)
    return cfg


def _get_config():
    return pconfig.set_trytond()


def set_user(user, config=None):
    if not config:
        config = pconfig.get_config()
    User = Model.get('res.user', config=config)
    config.user = int(user)
    config._context = User.get_preferences(True, {})


_dummy_test_case = unittest.TestCase()
_dummy_test_case.maxDiff = None


def __getattr__(name):
    return getattr(_dummy_test_case, name)

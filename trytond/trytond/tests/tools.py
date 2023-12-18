# This file is part of Tryton.  The COPYRIGHT file at the top level of
# this repository contains the full copyright notices and license terms.
from proteus import config as pconfig, Model, Wizard

from .test_tryton import restore_db_cache, backup_db_cache, drop_create

__all__ = ['activate_modules', 'set_user']


# PKU add cache_file_name
def activate_modules(modules, cache_file_name=None, setup_function=None):
    if isinstance(modules, str):
        modules = [modules]
    cache_name = cache_file_name or '-'.join(modules)
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
    Wizard('ir.module.activate_upgrade').execute('upgrade')

    if callable(setup_function):
        setup_function(cfg)
    backup_db_cache(cache_name)
    return cfg


def _get_config():
    cfg = pconfig.set_trytond()
    cfg.pool.test = True
    return cfg


def set_user(user, config=None):
    if not config:
        config = pconfig.get_config()
    User = Model.get('res.user', config=config)
    config.user = int(user)
    config._context = User.get_preferences(True, {})

#!/usr/bin/env python3
# This file is part of Tryton.  The COPYRIGHT file at the top level of
# this repository contains the full copyright notices and license terms.

import glob
import os
import re
import ssl
import sys
import tempfile
from subprocess import PIPE, Popen, check_call

from cx_Freeze import Executable, setup
from setuptools import find_packages

home = os.path.expanduser('~/')
pythonrc = os.path.join(home, '.pythonrc.py')
try:
    with open(pythonrc) as fp:
        exec(fp.read())
except IOError:
    pass


include_files = [
    (os.path.join(sys.prefix, 'share', 'glib-2.0', 'schemas'),
        os.path.join('share', 'glib-2.0', 'schemas')),
    (os.path.join(sys.prefix, 'lib', 'gtk-3.0'),
        os.path.join('lib', 'gtk-3.0')),
    (os.path.join(sys.prefix, 'lib', 'girepository-1.0'),
        os.path.join('lib', 'girepository-1.0')),
    (os.path.join(sys.prefix, 'lib', 'gdk-pixbuf-2.0'),
        os.path.join('lib', 'gdk-pixbuf-2.0')),
    (os.path.join(sys.prefix, 'lib', 'evince'),
        os.path.join('lib', 'evince')),
    (os.path.join(sys.prefix, 'share', 'icons', 'Adwaita'),
        os.path.join('share', 'icons', 'Adwaita')),
    (os.path.join(sys.platform, 'gtk-3.0', 'gtk.immodules'),
        os.path.join('share', 'gtk-3.0', 'gtk.immodules')),
    (os.path.join(sys.platform, 'gtk-3.0', 'gdk-pixbuf.loaders'),
        os.path.join('share', 'gtk-3.0', 'gdk-pixbuf.loaders')),
    (os.path.join(sys.platform, 'gtk-3.0', 'settings.ini'),
        os.path.join('etc', 'gtk-3.0', 'settings.ini')),
    ]

BIN_DIR = (os.path.join(sys.prefix, 'bin'))
for dll in [x for x in os.listdir(BIN_DIR) if x.endswith('.dll')]:
    include_files.append(os.path.join(sys.prefix, 'bin', dll))

required_gi_namespaces = [
    'Atk-1.0',
    'EvinceDocument-3.0',
    'EvinceView-3.0',
    'GLib-2.0',
    'GModule-2.0',
    'GObject-2.0',
    'Gdk-3.0',
    'GdkPixbuf-2.0',
    'Gio-2.0',
    'GooCanvas-[2-3].0',
    'Gtk-3.0',
    'GtkSource-3.0',
    'HarfBuzz-0.0',
    'Pango-1.0',
    'PangoCairo-1.0',
    'PangoFT2-1.0',
    'Rsvg-2.0',
    'cairo-1.0',
    'fontconfig-2.0',
    'freetype2-2.0',
    ]


def replace_path(match):
    libs = [os.path.basename(p) for p in match.group(1).split(',')]
    required_libs.update(libs)
    if sys.platform == 'darwin':
        prefix = '@executable_path/lib'
    else:
        prefix = 'lib'
    libs = [os.path.join(prefix, l) for l in libs]
    return 'shared-library="%s"' % ','.join(libs)


lib_re = re.compile(r'shared-library="([^\"]*)"')
required_libs = set()
temp = tempfile.mkdtemp()
for ns in required_gi_namespaces:
    gir_name = '%s.gir' % ns
    gir_file = glob.glob(
        os.path.join(sys.prefix, 'share', 'gir-1.0', gir_name))[0]
    gir_name = os.path.basename(gir_file)
    ns = os.path.splitext(gir_name)[0]
    gir_tmp = os.path.join(temp, gir_name)
    with open(gir_file, 'r', encoding='utf-8') as src:
        with open(gir_tmp, 'w', encoding='utf-8') as dst:
            for line in src:
                dst.write(lib_re.sub(replace_path, line))
    typefile_name = '%s.typelib' % ns
    typefile_file = os.path.join('lib', 'girepository-1.0', typefile_name)
    typefile_tmp = os.path.join(temp, typefile_name)
    check_call(['g-ir-compiler', '--output=' + typefile_tmp, gir_tmp])

    include_files.append((typefile_tmp, typefile_file))

if sys.platform == 'win32':
    include_files.extend([
        ('share/themes/Coog', 'share/themes/Coog'),
        ('share/languages/language2.rng', 'share/languages/language2.rng'),
        ('share/languages/def.lang', 'share/languages/def.lang'),
        ('share/languages/python.lang', 'share/languages/python.lang'),
        ('share/languages/python3.lang', 'share/languages/python3.lang'),
        ('share/styles/classic.xml', 'share/styles/classix.xml'),
        ('share/styles/styles.rng', 'share/styles/styles.rng'),
        ])
    dll_paths = os.getenv('PATH', os.defpath).split(os.pathsep)
    required_dlls = [
        'librsvg-2-2.dll',
        ]
    required_libs.update([
        'libepoxy-0.dll',
        ])
    lib_path = os.getenv('PATH', os.defpath).split(os.pathsep)
else:
    lib_path = [os.path.join(sys.prefix, 'lib')]
for lib in required_libs:
    for path in lib_path:
        path = os.path.join(path, lib)
        if os.path.isfile(path):
            break
    else:
        raise Exception('%s not found' % lib)
    include_files.append((path, os.path.join('lib', lib)))

ssl_paths = ssl.get_default_verify_paths()
include_files.append(
    (ssl_paths.openssl_cafile, os.path.join('share', 'ssl', 'cert.pem')))
if os.path.exists(ssl_paths.openssl_capath):
    include_files.append(
        (ssl_paths.openssl_capath, os.path.join('share', 'ssl', 'certs')))

version = Popen(
    'python3 ./setup.py --version', stdout=PIPE, shell=True, encoding='utf-8'
    ).stdout.read()
version = version.strip()

setup(name='tryton',
    version=version,
    options={
        'build_exe': {
            'no_compress': True,
            'include_files': include_files,
            'excludes': ['tkinter'],
            'silent': True,
            'packages': find_packages() + ['gi', 'timeit'],
            'include_msvcr': True,
            'path': sys.path.append("girepository-1.0"),
            },
        'bdist_mac': {
            'iconfile': os.path.join(
                'tryton', 'data', 'pixmaps', 'tryton', 'tryton.icns'),
            'bundle_name': 'Tryton',
            }
        },
    executables=[Executable(
            'bin/tryton',
            target_name='coog.exe',
            base='Win32GUI' if sys.platform == 'win32' else None,
            icon=os.path.join(
                'tryton', 'data', 'pixmaps', 'tryton', 'tryton.ico'),
            )])

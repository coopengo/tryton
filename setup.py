#!/usr/bin/env python
#This file is part of Tryton.  The COPYRIGHT file at the top level of
#this repository contains the full copyright notices and license terms.
from setuptools import setup, find_packages
import sys
import os
import proteus

major_version, minor_version, _ = proteus.__version__.split('.', 2)
major_version = int(major_version)
minor_version = int(minor_version)

SIMPLEJSON = []
if sys.version_info < (2, 6):
    SIMPLEJSON = ['simplejson']

def read(fname):
    return open(os.path.join(os.path.dirname(__file__), fname)).read()

setup(name='proteus',
    version=proteus.__version__,
    description='Library to access Tryton server as a client',
    long_description=read('README'),
    author='B2CK',
    author_email='info@b2ck.com',
    url='http://www.tryton.org/',
    download_url="http://downloads.tryton.org/" + \
            proteus.__version__.rsplit('.', 1)[0] + '/',
    packages=find_packages(),
    classifiers=[
        'Development Status :: 5 - Production/Stable',
        'Environment :: Plugins',
        'Intended Audience :: Developers',
        'Intended Audience :: Financial and Insurance Industry',
        'Intended Audience :: Legal Industry',
        'License :: OSI Approved :: GNU General Public License (GPL)',
        'Operating System :: OS Independent',
        'Programming Language :: Python',
        'Topic :: Office/Business',
    ],
    license='GPL-3',
    install_requires=SIMPLEJSON,
    extras_require={
        'trytond': ['trytond >= %s.%s, < %s.%s' %
            (major_version, minor_version, major_version, minor_version + 1)],
    },
    test_suite='proteus.tests',
)

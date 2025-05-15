# This file is part of Tryton.  The COPYRIGHT file at the top level of
# this repository contains the full copyright notices and license terms.

import ipaddress


def remote_address(context):
    from trytond.config import config

    ip_address = ''
    ip_network = ''
    if context.get('_request') and (
            remote_addr := context['_request'].get('remote_addr')):
        ip_address = ipaddress.ip_address(str(remote_addr))
        prefix = config.getint('session', f'ip_network_{ip_address.version}')
        ip_network = ipaddress.ip_network(str(remote_addr))
        ip_network = ip_network.supernet(new_prefix=prefix)
    return ip_address, ip_network

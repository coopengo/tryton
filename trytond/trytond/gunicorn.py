# This file is part of Tryton.  The COPYRIGHT file at the top level of
# this repository contains the full copyright notices and license terms.
import os
import logging
import resource
import csv
import time
import faulthandler
from io import StringIO

MAX_RSS_MB = 1024
CHECK_INTERVAL = 30  # seconds
_last_checked = {}
LF = '%(process)s %(thread)s [%(asctime)s] %(levelname)s %(name)s %(message)s'

logger = logging.getLogger()

db_names = os.environ.get('TRYTOND_DATABASE_NAMES')
db_list = []
if db_names:
    # Read with csv so database name can include special chars
    reader = csv.reader(StringIO(db_names))
    for name in next(reader):
        db_list.append(name)


def on_starting(server):
    '''
    on_starting() gunicorn hook called when starting server
    Here we use it to bind out file with trytond logging
    '''
    if server.cfg.accesslog:
        logging.basicConfig(level=str(server.cfg.loglevel).upper(),
            filename=server.cfg.accesslog, format=LF)


def post_request(worker, req, environ, resp):
    '''
    post_request() gunicorn hook called after a worker completed a request
    Since gunicorn doesn't feature uwsgi's --reload-on-rss to kill bloated
    workers
    '''
    now = time.time()

    pid = worker.pid
    # Only check every CHECK_INTERVAL seconds per worker
    logger.warning(f'Worker {pid} is being checked after '
        f'{_last_checked.get(pid, 0) + CHECK_INTERVAL}')

    if _last_checked.get(pid, 0) + CHECK_INTERVAL > now:
        return

    _last_checked[pid] = now
    usage = resource.getrusage(resource.RUSAGE_SELF)
    rss_mb = usage.ru_maxrss / (1024 ** 2)
    # To mimic uwsgi --reload-on-rss kill with inflated memory usage to
    # mitigate leaks
    if rss_mb > MAX_RSS_MB:
        logger.warning(f'Worker {pid} exceeded RSS limit: '
            f'{rss_mb} MB > {MAX_RSS_MB} MB. Exiting.')
        worker.alive = False


def worker_int(worker):
    """Called just before Gunicorn sends SIGQUIT or SIGINT on a failing worker"""
    logger.warning(f"Worker {worker.pid} killed — dumping traceback")

    # Dump traceback to designated file
    try:
        with open(f"/tmp/gunicorn-tracebacker-{worker.pid}.log", "w+")as f:
            faulthandler.dump_traceback(file=f, all_threads=True)
    except Exception as e:
        logger.error(f"Failed to dump traceback: {e}")


def worker_abort(worker):
    """Called just before Gunicorn sends SIGABRT to a worker after timeout."""
    logger.warning(f"Worker {worker.pid} timed out — dumping traceback")

    # Dump traceback to designated file
    try:
        with open(f"/tmp/gunicorn-tracebacker-{worker.pid}.log", "w+")as f:
            faulthandler.dump_traceback(file=f, all_threads=True)
    except Exception as e:
        logger.error(f"Failed to dump traceback: {e}")

import logging
from contextlib import contextmanager
from typing import Iterator

import psycopg2
from psycopg2 import pool
from psycopg2.extras import RealDictCursor

from config import settings

log = logging.getLogger("mhp.db")

_pool: pool.ThreadedConnectionPool | None = None


def init_pool() -> None:
    global _pool
    if _pool is not None:
        return
    _pool = pool.ThreadedConnectionPool(
        minconn=settings.pool_min_size,
        maxconn=settings.pool_max_size,
        host=settings.db_host,
        port=settings.db_port,
        database=settings.db_name,
        user=settings.db_user,
        password=settings.db_password,
        connect_timeout=5,
    )
    log.info("DB pool initialised (host=%s db=%s)", settings.db_host, settings.db_name)


def close_pool() -> None:
    global _pool
    if _pool is not None:
        _pool.closeall()
        _pool = None
        log.info("DB pool closed")


_STATEMENT_TIMEOUT_MS = 30_000  # 30s : protège des formules SQL lentes / boucles infinies


@contextmanager
def get_cursor(dict_cursor: bool = False) -> Iterator[tuple]:
    """Yield (cursor, conn). Commits on success, rollbacks on exception.

    Applique aussi un statement_timeout pour éviter qu'une formule SQL
    abusive immobilise une connexion du pool indéfiniment.
    """
    if _pool is None:
        raise RuntimeError("DB pool not initialised")
    conn = _pool.getconn()
    try:
        cur = conn.cursor(cursor_factory=RealDictCursor) if dict_cursor else conn.cursor()
        try:
            cur.execute(f"SET statement_timeout = {_STATEMENT_TIMEOUT_MS}")
            yield cur, conn
            conn.commit()
        except Exception:
            conn.rollback()
            raise
        finally:
            cur.close()
    finally:
        _pool.putconn(conn)


def ping() -> None:
    """Raise if the DB is not reachable."""
    with get_cursor() as (cur, _):
        cur.execute("SELECT 1")
        cur.fetchone()

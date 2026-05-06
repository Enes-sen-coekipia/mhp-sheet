"""
mhp — librairie helper exposée aux scripts utilisateur.

Usage dans un script :

    import mhp

    mhp.log("Hello")

    # Tables
    t = mhp.table('stock_it')
    print(len(t.rows()))
    t.append_row({'date': '2026-01-01', 'palettes_entree': '12'})
    t.update_cell(primary_val='2026-01-01', column='client', value='ABC')
    t.delete_row(primary_val='2026-01-01')

    # SQL libre (lecture)
    rows = mhp.sql("SELECT date, COUNT(*) AS n FROM stock_it GROUP BY date")

    # HTTP
    r = mhp.http.get('https://api.example.com/data', headers={'Authorization': 'Bearer xxx'})
    data = r.json()
    mhp.log(f"Status: {r.status}, items: {len(data)}")

    # Mail (SMTP)
    mhp.mail.send(
        to='admin@mhp.fr',
        subject='Rapport quotidien',
        body='Voir pièce jointe',
    )
"""
import json as _json
import os
import smtplib
import ssl
import urllib.parse
import urllib.request
from email.mime.multipart import MIMEMultipart
from email.mime.text import MIMEText

import psycopg2
import psycopg2.extras

# ─── Connexion DB (lazy, partagée) ───────────────────────────
_conn = None


def _connect():
    global _conn
    if _conn is None or _conn.closed:
        _conn = psycopg2.connect(
            host=os.environ["MHP_DB_HOST"],
            port=int(os.environ.get("MHP_DB_PORT", 5432)),
            database=os.environ["MHP_DB_NAME"],
            user=os.environ["MHP_DB_USER"],
            password=os.environ["MHP_DB_PASSWORD"],
            connect_timeout=5,
        )
    return _conn


# ─── Logging vers stdout (capté par le runner) ───────────────
def log(*args):
    msg = " ".join(str(a) for a in args)
    print(f"[LOG] {msg}", flush=True)


# ─── Tables ──────────────────────────────────────────────────
class Table:
    def __init__(self, name):
        self.name = str(name)
        c = _connect().cursor()
        c.execute(
            "SELECT column_name FROM information_schema.columns "
            "WHERE table_schema='public' AND table_name=%s ORDER BY ordinal_position",
            (self.name,),
        )
        cols = [r[0] for r in c.fetchall()]
        c.close()
        if not cols:
            raise ValueError(f"Table inconnue : {self.name}")
        self.columns = cols
        self.primary_col = cols[0]

    def rows(self, limit=None, where=None, params=None):
        c = _connect().cursor(cursor_factory=psycopg2.extras.RealDictCursor)
        sql = f'SELECT * FROM "{self.name}"'
        if where:
            sql += f" WHERE {where}"
        if limit:
            sql += f" LIMIT {int(limit)}"
        c.execute(sql, params or ())
        out = [dict(r) for r in c.fetchall()]
        c.close()
        return out

    def count(self, where=None, params=None):
        c = _connect().cursor()
        sql = f'SELECT COUNT(*) FROM "{self.name}"'
        if where:
            sql += f" WHERE {where}"
        c.execute(sql, params or ())
        n = c.fetchone()[0]
        c.close()
        return n

    def append_row(self, data):
        if not isinstance(data, dict) or not data:
            raise ValueError("append_row attend un dict non vide")
        for col in data.keys():
            if col not in self.columns:
                raise ValueError(f"Colonne inconnue dans {self.name} : {col}")
        cols_sql = ", ".join(f'"{c}"' for c in data.keys())
        placeholders = ", ".join(["%s"] * len(data))
        c = _connect().cursor()
        c.execute(f'INSERT INTO "{self.name}" ({cols_sql}) VALUES ({placeholders})', list(data.values()))
        _conn.commit()
        n = c.rowcount
        c.close()
        return n

    def append_rows(self, data_list):
        """Insère plusieurs lignes en une transaction. Toutes doivent partager les mêmes clés."""
        if not data_list:
            return 0
        keys = list(data_list[0].keys())
        cols_sql = ", ".join(f'"{c}"' for c in keys)
        placeholders = ", ".join(["%s"] * len(keys))
        rows = [tuple(d.get(k) for k in keys) for d in data_list]
        c = _connect().cursor()
        c.executemany(f'INSERT INTO "{self.name}" ({cols_sql}) VALUES ({placeholders})', rows)
        _conn.commit()
        n = c.rowcount
        c.close()
        return n

    def update_cell(self, primary_val, column, value):
        if column not in self.columns:
            raise ValueError(f"Colonne inconnue : {column}")
        c = _connect().cursor()
        c.execute(
            f'UPDATE "{self.name}" SET "{column}" = %s WHERE "{self.primary_col}" = %s',
            (value, primary_val),
        )
        _conn.commit()
        n = c.rowcount
        c.close()
        return n

    def delete_row(self, primary_val):
        c = _connect().cursor()
        c.execute(f'DELETE FROM "{self.name}" WHERE "{self.primary_col}" = %s', (primary_val,))
        _conn.commit()
        n = c.rowcount
        c.close()
        return n

    def __repr__(self):
        return f"<mhp.Table {self.name!r} cols={self.columns}>"


def table(name):
    """Renvoie un helper Table."""
    return Table(name)


def tables():
    """Liste toutes les tables publiques (hors internes _*)."""
    c = _connect().cursor()
    c.execute(
        "SELECT table_name FROM information_schema.tables "
        "WHERE table_schema='public' AND table_type='BASE TABLE' "
        "AND table_name NOT LIKE %s ORDER BY table_name",
        ("\\_%",),
    )
    out = [r[0] for r in c.fetchall()]
    c.close()
    return out


def sql(query, params=None):
    """Exécute du SQL libre. SELECT renvoie une liste de dicts ; sinon renvoie le rowcount."""
    c = _connect().cursor(cursor_factory=psycopg2.extras.RealDictCursor)
    c.execute(query, params or ())
    if c.description:
        out = [dict(r) for r in c.fetchall()]
    else:
        out = c.rowcount
    _conn.commit()
    c.close()
    return out


# ─── HTTP ────────────────────────────────────────────────────
class _Response:
    def __init__(self, status, headers, content):
        self.status = status
        self.headers = headers
        self.content = content
        self.text = content.decode("utf-8", errors="replace")

    def json(self):
        return _json.loads(self.text)

    def __repr__(self):
        return f"<mhp.http.Response {self.status}>"


class _HTTP:
    @staticmethod
    def _do(method, url, headers=None, body=None, timeout=30):
        req = urllib.request.Request(url, data=body, headers=headers or {}, method=method)
        try:
            with urllib.request.urlopen(req, timeout=timeout) as r:
                return _Response(r.status, dict(r.headers), r.read())
        except urllib.error.HTTPError as e:
            # Renvoie une Response même sur 4xx/5xx au lieu de raise
            return _Response(e.code, dict(e.headers or {}), e.read())

    def get(self, url, headers=None, params=None, timeout=30):
        if params:
            url += ("&" if "?" in url else "?") + urllib.parse.urlencode(params)
        return self._do("GET", url, headers=headers, timeout=timeout)

    def post(self, url, json=None, data=None, headers=None, timeout=30):
        h = dict(headers or {})
        body = None
        if json is not None:
            body = _json.dumps(json).encode("utf-8")
            h.setdefault("Content-Type", "application/json")
        elif data is not None:
            body = data.encode("utf-8") if isinstance(data, str) else data
        return self._do("POST", url, headers=h, body=body, timeout=timeout)

    def put(self, url, json=None, headers=None, timeout=30):
        h = dict(headers or {})
        body = _json.dumps(json).encode("utf-8") if json is not None else None
        if body:
            h.setdefault("Content-Type", "application/json")
        return self._do("PUT", url, headers=h, body=body, timeout=timeout)

    def delete(self, url, headers=None, timeout=30):
        return self._do("DELETE", url, headers=headers, timeout=timeout)


http = _HTTP()


# ─── Mail (SMTP) ─────────────────────────────────────────────
class _Mail:
    def send(self, to, subject, body, html=None, from_addr=None,
             smtp_host=None, smtp_port=None, smtp_user=None, smtp_password=None, use_tls=True):
        """Envoie un mail via SMTP. Lit les credentials depuis MHP_SMTP_* si non fournis."""
        smtp_host = smtp_host or os.environ.get("MHP_SMTP_HOST")
        smtp_port = int(smtp_port or os.environ.get("MHP_SMTP_PORT", 587))
        smtp_user = smtp_user or os.environ.get("MHP_SMTP_USER")
        smtp_password = smtp_password or os.environ.get("MHP_SMTP_PASSWORD")
        from_addr = from_addr or os.environ.get("MHP_SMTP_FROM", smtp_user)
        if not smtp_host:
            raise RuntimeError("Configurer MHP_SMTP_HOST/USER/PASSWORD dans .env pour envoyer du mail")

        msg = MIMEMultipart("alternative")
        msg["Subject"] = subject
        msg["From"] = from_addr
        msg["To"] = to if isinstance(to, str) else ", ".join(to)
        msg.attach(MIMEText(body, "plain", "utf-8"))
        if html:
            msg.attach(MIMEText(html, "html", "utf-8"))

        ctx = ssl.create_default_context()
        with smtplib.SMTP(smtp_host, smtp_port, timeout=20) as s:
            if use_tls:
                s.starttls(context=ctx)
            if smtp_user:
                s.login(smtp_user, smtp_password)
            s.send_message(msg)


mail = _Mail()

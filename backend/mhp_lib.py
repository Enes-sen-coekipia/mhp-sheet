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


# ─── Google (Gmail / Drive / Sheets) ─────────────────────────
# Lazy imports : si on n'utilise pas Google, pas besoin que les libs
# google-auth-* soient installées (utile pour les scripts pure-DB / HTTP).
def _g_service(name):
    from services.google import gmail_service, drive_service, sheets_service
    return {"gmail": gmail_service, "drive": drive_service, "sheets": sheets_service}[name]()


class _Gmail:
    """Helper Gmail. Compte connecté via Intégrations → Google."""

    def search(self, query: str, max_results: int = 25):
        """Cherche des messages selon la syntaxe Gmail (ex: 'label:stockit has:attachment newer_than:2d')."""
        svc = _g_service("gmail")
        res = svc.users().messages().list(userId="me", q=query, maxResults=max_results).execute()
        return res.get("messages", [])

    def get_message(self, message_id: str, fmt: str = "full"):
        svc = _g_service("gmail")
        return svc.users().messages().get(userId="me", id=message_id, format=fmt).execute()

    def get_attachments(self, message_id: str):
        """Renvoie [{filename, mime_type, data (bytes), attachment_id}] pour ce message."""
        import base64
        svc = _g_service("gmail")
        msg = svc.users().messages().get(userId="me", id=message_id, format="full").execute()
        out = []
        def walk(parts):
            for p in parts or []:
                fn = p.get("filename") or ""
                body = p.get("body") or {}
                aid = body.get("attachmentId")
                if fn and aid:
                    att = svc.users().messages().attachments().get(
                        userId="me", messageId=message_id, id=aid
                    ).execute()
                    data = base64.urlsafe_b64decode(att["data"].encode("utf-8"))
                    out.append({
                        "filename": fn,
                        "mime_type": p.get("mimeType", ""),
                        "data": data,
                        "size": len(data),
                        "attachment_id": aid,
                    })
                if p.get("parts"):
                    walk(p["parts"])
        walk((msg.get("payload") or {}).get("parts"))
        return out

    def get_latest_with_label(self, label: str, max_age_days: int = 7):
        """Helper : retourne le message le plus récent avec ce libellé (ou None)."""
        msgs = self.search(f"label:{label} newer_than:{max_age_days}d", max_results=1)
        if not msgs:
            return None
        return self.get_message(msgs[0]["id"])

    def add_label(self, message_id: str, label_id: str):
        svc = _g_service("gmail")
        svc.users().messages().modify(
            userId="me", id=message_id, body={"addLabelIds": [label_id]}
        ).execute()

    def list_labels(self):
        svc = _g_service("gmail")
        return svc.users().labels().list(userId="me").execute().get("labels", [])


class _Drive:
    """Helper Drive."""

    def upload(self, name: str, content: bytes, mime_type: str = "application/octet-stream",
               folder_id: str | None = None):
        """Upload un fichier. Retourne l'objet file (id, name, etc.)."""
        from googleapiclient.http import MediaInMemoryUpload
        svc = _g_service("drive")
        meta = {"name": name}
        if folder_id:
            meta["parents"] = [folder_id]
        media = MediaInMemoryUpload(content, mimetype=mime_type)
        return svc.files().create(body=meta, media_body=media, fields="id,name,mimeType,webViewLink").execute()

    def upload_and_convert_to_sheets(self, name: str, content: bytes,
                                     source_mime: str = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"):
        """Upload un .xlsx et le convertit en Google Sheets. Retourne le file id du Sheets."""
        from googleapiclient.http import MediaInMemoryUpload
        svc = _g_service("drive")
        meta = {"name": name, "mimeType": "application/vnd.google-apps.spreadsheet"}
        media = MediaInMemoryUpload(content, mimetype=source_mime, resumable=False)
        f = svc.files().create(body=meta, media_body=media, fields="id,name").execute()
        return f

    def export(self, file_id: str, mime_type: str = "text/csv") -> bytes:
        """Exporte un Google file (Sheets/Docs) au format demandé. Retourne bytes."""
        svc = _g_service("drive")
        return svc.files().export(fileId=file_id, mimeType=mime_type).execute()

    def export_csv(self, file_id: str) -> str:
        """Exporte un Google Sheets en CSV (texte)."""
        return self.export(file_id, "text/csv").decode("utf-8", errors="replace")

    def download(self, file_id: str) -> bytes:
        svc = _g_service("drive")
        return svc.files().get_media(fileId=file_id).execute()

    def get(self, file_id: str):
        svc = _g_service("drive")
        return svc.files().get(fileId=file_id, fields="id,name,mimeType,parents,webViewLink").execute()

    def list_in_folder(self, folder_id: str, mime_type: str | None = None):
        svc = _g_service("drive")
        q = f"'{folder_id}' in parents and trashed=false"
        if mime_type:
            q += f" and mimeType='{mime_type}'"
        res = svc.files().list(q=q, fields="files(id,name,mimeType,parents)").execute()
        return res.get("files", [])

    def delete(self, file_id: str, trash: bool = True):
        """trash=True (défaut) → met à la corbeille. trash=False → suppression définitive."""
        svc = _g_service("drive")
        if trash:
            svc.files().update(fileId=file_id, body={"trashed": True}).execute()
        else:
            svc.files().delete(fileId=file_id).execute()

    def find_folder(self, name: str, parent_id: str | None = None):
        """Trouve un dossier par nom. Retourne le 1er match ou None."""
        svc = _g_service("drive")
        q = f"name='{name}' and mimeType='application/vnd.google-apps.folder' and trashed=false"
        if parent_id:
            q += f" and '{parent_id}' in parents"
        res = svc.files().list(q=q, fields="files(id,name,parents)").execute().get("files", [])
        return res[0] if res else None


class _Sheets:
    """Helper Sheets (lecture/écriture sur un Google Sheets existant)."""

    def get_values(self, spreadsheet_id: str, range_a1: str):
        svc = _g_service("sheets")
        res = svc.spreadsheets().values().get(spreadsheetId=spreadsheet_id, range=range_a1).execute()
        return res.get("values", [])

    def set_values(self, spreadsheet_id: str, range_a1: str, values: list[list]):
        svc = _g_service("sheets")
        return svc.spreadsheets().values().update(
            spreadsheetId=spreadsheet_id, range=range_a1,
            valueInputOption="USER_ENTERED",
            body={"values": values},
        ).execute()

    def append_values(self, spreadsheet_id: str, range_a1: str, values: list[list]):
        svc = _g_service("sheets")
        return svc.spreadsheets().values().append(
            spreadsheetId=spreadsheet_id, range=range_a1,
            valueInputOption="USER_ENTERED",
            insertDataOption="INSERT_ROWS",
            body={"values": values},
        ).execute()


gmail = _Gmail()
drive = _Drive()
sheets = _Sheets()


# ─── Chaînage de scripts (mhp.run_script) ────────────────────
def run_script(name_or_id, body=None, timeout=120):
    """Exécute un autre script et attend sa fin. Retourne {status, output, error, duration_ms}.

    Usage :
        result = mhp.run_script('importStockIt')
        result = mhp.run_script('mailQuotidien', body={'destinataires':['admin@mhp.fr']})

    L'autre script reçoit le body dans os.environ['MHP_INVOKE_BODY'] (JSON serialisé).
    Implémenté via un appel HTTP à /api/scripts/.../invoke pour éviter tout couplage
    avec le pool DB du backend.
    """
    api_base = os.environ.get("MHP_API_INTERNAL", "http://127.0.0.1:8000")
    token = os.environ.get("MHP_INGEST_TOKEN") or os.environ.get("INGEST_API_TOKEN", "")

    if isinstance(name_or_id, int) or (isinstance(name_or_id, str) and name_or_id.isdigit()):
        url = f"{api_base}/scripts/{name_or_id}/invoke"
    else:
        url = f"{api_base}/scripts/by-name/{name_or_id}/invoke"

    body_bytes = _json.dumps(body or {}).encode("utf-8")
    headers = {"Content-Type": "application/json"}
    if token:
        headers["X-API-Token"] = token

    req = urllib.request.Request(url, data=body_bytes, headers=headers, method="POST")
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return _json.loads(r.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        text = e.read().decode("utf-8", errors="replace")
        raise RuntimeError(f"run_script HTTP {e.code} : {text[:200]}")


# Exposition env vars utiles pour les scripts invoqués via /invoke ou par un autre script
def get_invoke_body():
    """Récupère le body JSON passé à un script.

    Cherche dans cet ordre :
    - MHP_INVOKE_BODY (déclenchement via /invoke ou mhp.run_script(body=...))
    - MHP_WEBHOOK_BODY_JSON (déclenchement on_webhook)
    - MHP_WEBHOOK_BODY_RAW (fallback texte brut si webhook non-JSON)
    - MHP_TRIGGER_ROW_DATA (déclenchement on_row_add)

    Renvoie None si rien, dict si JSON valide, str sinon.
    """
    raw = (
        os.environ.get("MHP_INVOKE_BODY")
        or os.environ.get("MHP_WEBHOOK_BODY_JSON")
        or os.environ.get("MHP_TRIGGER_ROW_DATA")
        or os.environ.get("MHP_WEBHOOK_BODY_RAW")
        or ""
    )
    if not raw:
        return None
    try:
        return _json.loads(raw)
    except Exception:
        return raw


"""Google OAuth + cache des credentials.

Le compte Google est unique pour toute l'application (single-tenant).
Les tokens sont persistés dans _mhp_integrations en JSONB et rafraîchis
automatiquement quand expirés.
"""
import json
import logging
import secrets as _secrets
import time
from datetime import datetime
from typing import Optional

from fastapi import HTTPException, status
from google.auth.transport.requests import Request as GoogleRequest
from google.oauth2.credentials import Credentials
from google_auth_oauthlib.flow import Flow
from googleapiclient.discovery import build

from config import settings
from db import get_cursor

log = logging.getLogger("mhp.google")

# Scopes : Gmail (read), Drive (full), Sheets (full), profil utilisateur
SCOPES = [
    "https://www.googleapis.com/auth/gmail.modify",
    "https://www.googleapis.com/auth/drive",
    "https://www.googleapis.com/auth/spreadsheets",
    "https://www.googleapis.com/auth/userinfo.email",
    "https://www.googleapis.com/auth/userinfo.profile",
    "openid",
]

# Store en mémoire pour le state OAuth (TTL 10 min)
_states: dict[str, float] = {}
_STATE_TTL = 600


def _client_config() -> dict:
    if not settings.google_oauth_client_id or not settings.google_oauth_client_secret:
        raise HTTPException(
            status.HTTP_503_SERVICE_UNAVAILABLE,
            "OAuth Google non configuré. Renseigner GOOGLE_OAUTH_CLIENT_ID et "
            "GOOGLE_OAUTH_CLIENT_SECRET dans .env (voir DEPLOY.md §Google).",
        )
    return {
        "web": {
            "client_id": settings.google_oauth_client_id,
            "client_secret": settings.google_oauth_client_secret,
            "auth_uri": "https://accounts.google.com/o/oauth2/auth",
            "token_uri": "https://oauth2.googleapis.com/token",
            "auth_provider_x509_cert_url": "https://www.googleapis.com/oauth2/v1/certs",
        }
    }


def _new_flow() -> Flow:
    flow = Flow.from_client_config(_client_config(), scopes=SCOPES)
    flow.redirect_uri = settings.google_oauth_redirect_uri
    return flow


def _purge_old_states() -> None:
    cutoff = time.time() - _STATE_TTL
    for s, t in list(_states.items()):
        if t < cutoff:
            del _states[s]


def get_authorization_url() -> str:
    """Renvoie l'URL Google de consentement à laquelle rediriger l'utilisateur."""
    _purge_old_states()
    state = _secrets.token_urlsafe(24)
    _states[state] = time.time()
    flow = _new_flow()
    auth_url, _ = flow.authorization_url(
        access_type="offline",
        prompt="consent",
        include_granted_scopes="true",
        state=state,
    )
    return auth_url


def exchange_code(code: str, state: str) -> dict:
    """Échange le code reçu sur le callback contre des tokens, et persiste."""
    _purge_old_states()
    if state not in _states:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "State OAuth invalide ou expiré")
    del _states[state]

    flow = _new_flow()
    try:
        flow.fetch_token(code=code)
    except Exception as e:
        log.exception("OAuth fetch_token failed")
        raise HTTPException(status.HTTP_400_BAD_REQUEST, f"Échec OAuth Google : {e}")

    creds = flow.credentials
    # Récupère email du compte
    email = ""
    try:
        info = build("oauth2", "v2", credentials=creds, cache_discovery=False).userinfo().get().execute()
        email = info.get("email", "")
    except Exception:
        log.exception("Failed to fetch user info")

    raw = json.loads(creds.to_json())
    with get_cursor() as (cur, _):
        # Single-tenant : on supprime tout précédent compte
        cur.execute("DELETE FROM _mhp_integrations WHERE provider = 'google'")
        cur.execute(
            """
            INSERT INTO _mhp_integrations (provider, account_id, account_email, scopes, raw_token)
            VALUES ('google', %s, %s, %s, %s::jsonb)
            """,
            (email or "default", email, ",".join(creds.scopes or []), json.dumps(raw)),
        )
    log.info("Google account connected: %s", email)
    return {"connected": True, "account_email": email}


def get_status() -> dict:
    """Renvoie l'état de la connexion Google."""
    with get_cursor(dict_cursor=True) as (cur, _):
        cur.execute(
            "SELECT account_email, scopes, connected_at, refreshed_at "
            "FROM _mhp_integrations WHERE provider='google' LIMIT 1"
        )
        row = cur.fetchone()
    configured = bool(settings.google_oauth_client_id and settings.google_oauth_client_secret)
    if not row:
        return {
            "configured": configured,
            "connected": False,
            "redirect_uri": settings.google_oauth_redirect_uri,
        }
    return {
        "configured": configured,
        "connected": True,
        "account_email": row["account_email"],
        "scopes": (row["scopes"] or "").split(","),
        "connected_at": row["connected_at"].isoformat() if row["connected_at"] else None,
        "refreshed_at": row["refreshed_at"].isoformat() if row["refreshed_at"] else None,
        "redirect_uri": settings.google_oauth_redirect_uri,
    }


def disconnect() -> dict:
    with get_cursor() as (cur, _):
        cur.execute("DELETE FROM _mhp_integrations WHERE provider='google'")
        n = cur.rowcount
    return {"disconnected": n > 0}


# ─── Helpers utilisés par mhp_lib (côté scripts utilisateur) ──
def get_credentials() -> Credentials:
    """Récupère les credentials Google, refresh si expirés. Lève si pas connecté."""
    with get_cursor(dict_cursor=True) as (cur, _):
        cur.execute("SELECT raw_token FROM _mhp_integrations WHERE provider='google' LIMIT 1")
        row = cur.fetchone()
    if not row:
        raise RuntimeError("Aucun compte Google connecté. Va dans Intégrations → Connecter Google.")

    info = row["raw_token"] if isinstance(row["raw_token"], dict) else json.loads(row["raw_token"])
    creds = Credentials.from_authorized_user_info(info, SCOPES)

    if not creds.valid:
        if creds.expired and creds.refresh_token:
            try:
                creds.refresh(GoogleRequest())
            except Exception as e:
                log.exception("Google token refresh failed")
                raise RuntimeError(f"Refresh token Google échoué : {e}. Reconnecte le compte.")
            new_raw = json.loads(creds.to_json())
            with get_cursor() as (cur, _):
                cur.execute(
                    "UPDATE _mhp_integrations SET raw_token = %s::jsonb, refreshed_at = NOW() "
                    "WHERE provider='google'",
                    (json.dumps(new_raw),),
                )
        else:
            raise RuntimeError("Credentials Google invalides — reconnecte le compte.")

    return creds


def gmail_service():
    return build("gmail", "v1", credentials=get_credentials(), cache_discovery=False)


def drive_service():
    return build("drive", "v3", credentials=get_credentials(), cache_discovery=False)


def sheets_service():
    return build("sheets", "v4", credentials=get_credentials(), cache_discovery=False)

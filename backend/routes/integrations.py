"""Endpoints OAuth Google : connect / callback / status / disconnect."""
import logging

from fastapi import APIRouter, Query
from fastapi.responses import HTMLResponse, RedirectResponse

from services.google import (
    disconnect as g_disconnect,
    exchange_code,
    get_authorization_url,
    get_status,
)

router = APIRouter(prefix="/integrations", tags=["integrations"])
log = logging.getLogger("mhp.integrations")


@router.get("/google/status")
def google_status():
    return get_status()


@router.get("/google/connect")
def google_connect():
    """Renvoie l'URL Google de consentement. Le frontend ouvre cette URL."""
    return {"authorization_url": get_authorization_url()}


@router.get("/google/callback")
def google_callback(code: str = Query(...), state: str = Query(...)):
    """Endpoint sur lequel Google redirige après consentement."""
    try:
        exchange_code(code, state)
        return HTMLResponse(
            """
            <!DOCTYPE html>
            <html><head><meta charset="utf-8"><title>OK</title></head>
            <body style="font-family:sans-serif;background:#0f1117;color:#e2e8f0;
                         display:flex;align-items:center;justify-content:center;height:100vh;">
              <div style="text-align:center;">
                <h2 style="color:#22c55e">✓ Compte Google connecté</h2>
                <p>Tu peux fermer cet onglet et revenir à MHP DataSheet.</p>
                <script>setTimeout(()=>{ window.close(); window.location.href='/'; }, 1500);</script>
              </div>
            </body></html>
            """,
            status_code=200,
        )
    except Exception as e:
        log.exception("OAuth callback error")
        return HTMLResponse(
            f"""
            <!DOCTYPE html>
            <html><head><meta charset="utf-8"></head>
            <body style="font-family:sans-serif;background:#0f1117;color:#e2e8f0;
                         display:flex;align-items:center;justify-content:center;height:100vh;">
              <div style="text-align:center;max-width:600px;padding:20px;">
                <h2 style="color:#ef4444">❌ Erreur OAuth Google</h2>
                <pre style="background:#1f2330;padding:12px;border-radius:6px;text-align:left;">{e}</pre>
                <p>Ferme cet onglet et réessaye.</p>
              </div>
            </body></html>
            """,
            status_code=400,
        )


@router.delete("/google")
def google_disconnect():
    return g_disconnect()

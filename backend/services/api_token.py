"""Middleware simple : vérification du token X-API-Token sur les écritures externes."""
from fastapi import HTTPException, Request, status

from config import settings


def require_ingest_token(request: Request) -> None:
    """Vérifie le token sur une requête entrante.

    - Si INGEST_API_TOKEN est vide dans .env : pas de check (mode dev / LAN trusted).
    - Sinon : exige le header X-API-Token ou le query param ?api_token=.
    """
    expected = settings.ingest_api_token
    if not expected:
        return
    received = request.headers.get("X-API-Token") or request.query_params.get("api_token")
    if not received or received != expected:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Token d'ingestion invalide ou manquant (header X-API-Token).",
        )

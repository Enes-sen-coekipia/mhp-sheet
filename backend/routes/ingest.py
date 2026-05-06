"""Endpoints d'ingestion — pour Apps Script et webhooks externes.

Patterns supportés :
- append      : INSERT en batch
- upsert      : DELETE+INSERT par clé composite (sans contrainte unique nécessaire)
- replace_all : TRUNCATE (ou DELETE WHERE) puis INSERT
- webhook     : reçoit n'importe quel JSON, stocke dans _mhp_webhooks, déclenche on_webhook
"""
import json
import logging
from typing import Any, Literal

from fastapi import APIRouter, HTTPException, Query, Request, status
from pydantic import BaseModel, Field

from db import get_cursor
from services.api_token import require_ingest_token
from services.security import safe_identifier, validate_column, validate_table
from services.triggers import fire_on_row_add, fire_on_webhook

log = logging.getLogger("mhp.ingest")
router = APIRouter(tags=["ingest"])


# ═════════════════════════════════════════════════════════════
#  INSERT BATCH AVEC MODES (append / upsert / replace_all)
# ═════════════════════════════════════════════════════════════
class IngestRows(BaseModel):
    rows: list[dict[str, Any]] = Field(..., min_length=1, max_length=10000)
    mode: Literal["append", "upsert", "replace_all"] = "append"
    primary_keys: list[str] | None = None      # requis si mode='upsert'
    truncate_where: str | None = None          # optionnel si mode='replace_all', sinon TRUNCATE total
    fire_triggers: bool = False                # si True : déclenche on_row_add pour chaque ligne


@router.post("/table/{table_name}/rows", status_code=status.HTTP_200_OK)
def ingest_rows(table_name: str, payload: IngestRows, request: Request):
    """Insertion en masse, avec 3 modes de fusion.

    Exemples de payload :
      append :
        {"rows": [{"date":"...","val":"..."}], "mode":"append"}

      upsert (réécrit si la clé existe déjà) :
        {"rows":[...], "mode":"upsert", "primary_keys":["date","sequential_id"]}

      replace_all (vide la table puis insère) :
        {"rows":[...], "mode":"replace_all"}

      replace partiel (vide une période puis réinsère) :
        {"rows":[...], "mode":"replace_all", "truncate_where":"date >= '2025-09-01'"}
    """
    require_ingest_token(request)
    table = validate_table(table_name)

    # Toutes les colonnes uniques mentionnées dans les rows
    cols_set: set[str] = set()
    for r in payload.rows:
        cols_set.update(r.keys())
    if not cols_set:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Les lignes sont vides")
    columns = sorted(cols_set)
    for c in columns:
        validate_column(table, c)
    if payload.primary_keys:
        for pk in payload.primary_keys:
            validate_column(table, pk)

    cols_sql = ", ".join(f'"{c}"' for c in columns)
    placeholders = ", ".join(["%s"] * len(columns))
    insert_sql = f'INSERT INTO "{table}" ({cols_sql}) VALUES ({placeholders})'

    inserted = 0
    deleted = 0

    with get_cursor() as (cur, _):
        # ── Mode replace_all : on vide d'abord ──
        if payload.mode == "replace_all":
            if payload.truncate_where:
                # Validation du WHERE (basique) : pas de ; ni --
                where_clean = payload.truncate_where.strip()
                if ";" in where_clean or "--" in where_clean or "/*" in where_clean:
                    raise HTTPException(status.HTTP_400_BAD_REQUEST, "truncate_where invalide")
                cur.execute(f'DELETE FROM "{table}" WHERE {where_clean}')
            else:
                cur.execute(f'TRUNCATE TABLE "{table}"')
            deleted = cur.rowcount

        # ── Mode upsert : DELETE par clé puis INSERT ──
        if payload.mode == "upsert":
            if not payload.primary_keys:
                raise HTTPException(
                    status.HTTP_400_BAD_REQUEST,
                    "mode='upsert' requiert primary_keys (ex: ['date','sequential_id'])",
                )
            pk_where = " AND ".join(f'"{c}" = %s' for c in payload.primary_keys)
            del_sql = f'DELETE FROM "{table}" WHERE {pk_where}'
            for row in payload.rows:
                cur.execute(del_sql, [row.get(pk) for pk in payload.primary_keys])
                deleted += cur.rowcount
                cur.execute(insert_sql, [row.get(c) for c in columns])
                inserted += 1
        else:
            # append + replace_all : INSERT en boucle (executemany pour perf)
            values_list = [tuple(row.get(c) for c in columns) for row in payload.rows]
            cur.executemany(insert_sql, values_list)
            inserted = cur.rowcount if cur.rowcount > 0 else len(values_list)

    # Triggers on_row_add (optionnel, peut être lourd)
    if payload.fire_triggers and payload.mode != "replace_all":
        for row in payload.rows:
            pk_val = next(iter(row.values())) if row else ""
            fire_on_row_add(table, str(pk_val), row)

    return {
        "table": table,
        "mode": payload.mode,
        "submitted": len(payload.rows),
        "inserted": inserted,
        "deleted": deleted,
    }


# ═════════════════════════════════════════════════════════════
#  WEBHOOK GÉNÉRIQUE
# ═════════════════════════════════════════════════════════════
@router.post("/webhook/{slug}")
async def receive_webhook(slug: str, request: Request):
    """Endpoint générique : reçoit n'importe quel POST, stocke + déclenche on_webhook.

    Le slug identifie la source (ex: 'shiptify'). Les payloads sont conservés dans
    _mhp_webhooks pour debug. Si un script a trigger_type='on_webhook' avec ce slug,
    il est exécuté avec le payload en variables d'environnement.

    Auth optionnelle :
      - Header X-API-Token, OU ?api_token=  (si INGEST_API_TOKEN configuré)
      - Sinon : ouvert (pour les services externes type Shiptify qui ne peuvent
        pas toujours envoyer un header custom, prévoir token via URL si nécessaire)
    """
    safe_identifier(slug)  # protège la table SQL des slugs farfelus

    body_bytes = await request.body()
    body_raw = body_bytes.decode("utf-8", errors="replace")[:200_000]  # cap 200k chars
    headers_dict = {k: v for k, v in request.headers.items() if k.lower() not in ("authorization", "cookie")}

    body_json = None
    try:
        body_json = json.loads(body_raw) if body_raw else None
    except Exception:
        body_json = None

    with get_cursor(dict_cursor=True) as (cur, _):
        cur.execute(
            """
            INSERT INTO _mhp_webhooks (slug, headers, body_json, body_raw, source_ip)
            VALUES (%s, %s::jsonb, %s::jsonb, %s, %s)
            RETURNING id, received_at
            """,
            (
                slug,
                json.dumps(headers_dict),
                json.dumps(body_json) if body_json is not None else None,
                body_raw,
                request.client.host if request.client else None,
            ),
        )
        row = cur.fetchone()
        webhook_id = row["id"]

    # Trigger éventuel
    fire_on_webhook(slug, webhook_id, headers_dict, body_json, body_raw)

    return {"received": True, "webhook_id": webhook_id, "slug": slug}


@router.get("/webhooks")
def list_webhooks(slug: str | None = None, limit: int = Query(50, ge=1, le=500)):
    """Liste les derniers webhooks reçus (pour debug)."""
    with get_cursor(dict_cursor=True) as (cur, _):
        if slug:
            cur.execute(
                "SELECT id, slug, received_at, source_ip, "
                "LEFT(COALESCE(body_raw,''), 500) AS body_preview "
                "FROM _mhp_webhooks WHERE slug = %s ORDER BY received_at DESC LIMIT %s",
                (slug, limit),
            )
        else:
            cur.execute(
                "SELECT id, slug, received_at, source_ip, "
                "LEFT(COALESCE(body_raw,''), 500) AS body_preview "
                "FROM _mhp_webhooks ORDER BY received_at DESC LIMIT %s",
                (limit,),
            )
        return {"webhooks": [dict(r) for r in cur.fetchall()]}


@router.get("/webhooks/{webhook_id}")
def get_webhook(webhook_id: int):
    """Détail complet d'un webhook reçu."""
    with get_cursor(dict_cursor=True) as (cur, _):
        cur.execute("SELECT * FROM _mhp_webhooks WHERE id = %s", (webhook_id,))
        row = cur.fetchone()
        if not row:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "Webhook introuvable")
        return dict(row)

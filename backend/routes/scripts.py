"""Endpoints CRUD scripts + run-now + listing runs."""
import re

from fastapi import APIRouter, HTTPException, Query, status
from pydantic import BaseModel, Field

from db import get_cursor
from services.scheduler import list_scheduled_jobs, reload_jobs
from services.scripts_runner import run_script

router = APIRouter(prefix="/scripts", tags=["scripts"])

NAME_RE = re.compile(r"^[a-zA-Z0-9_\- ]{1,64}$")
ALLOWED_TRIGGERS = {"manual", "cron", "on_edit", "on_row_add"}


class ScriptIn(BaseModel):
    name: str = Field(..., min_length=1, max_length=64)
    description: str = ""
    code: str = ""
    trigger_type: str = "manual"
    trigger_cron: str | None = None
    trigger_table: str | None = None
    enabled: bool = True
    sandboxed: bool = False


class ScriptUpdate(BaseModel):
    name: str | None = None
    description: str | None = None
    code: str | None = None
    trigger_type: str | None = None
    trigger_cron: str | None = None
    trigger_table: str | None = None
    enabled: bool | None = None
    sandboxed: bool | None = None


def _validate_payload(payload: ScriptIn | ScriptUpdate):
    if hasattr(payload, "name") and payload.name is not None and not NAME_RE.match(payload.name):
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Nom invalide")
    if hasattr(payload, "trigger_type") and payload.trigger_type and payload.trigger_type not in ALLOWED_TRIGGERS:
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST,
            f"trigger_type doit être {sorted(ALLOWED_TRIGGERS)}",
        )


# ─── CRUD ────────────────────────────────────────────────────
@router.get("")
def list_scripts():
    with get_cursor(dict_cursor=True) as (cur, _):
        cur.execute(
            """
            SELECT id, name, description, language, trigger_type, trigger_cron,
                   trigger_table, enabled, sandboxed, created_at, updated_at
            FROM _mhp_scripts ORDER BY name
            """
        )
        return {"scripts": [dict(r) for r in cur.fetchall()]}


@router.get("/scheduled")
def list_scheduled():
    """Pour debug : montre les jobs cron actuellement programmés en mémoire."""
    return {"jobs": list_scheduled_jobs()}


@router.get("/{script_id}")
def get_script(script_id: int):
    with get_cursor(dict_cursor=True) as (cur, _):
        cur.execute("SELECT * FROM _mhp_scripts WHERE id = %s", (script_id,))
        row = cur.fetchone()
        if not row:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "Script introuvable")
        return dict(row)


@router.post("", status_code=status.HTTP_201_CREATED)
def create_script(payload: ScriptIn):
    _validate_payload(payload)
    with get_cursor(dict_cursor=True) as (cur, _):
        cur.execute(
            """
            INSERT INTO _mhp_scripts (name, description, code, trigger_type,
                                      trigger_cron, trigger_table, enabled, sandboxed)
            VALUES (%s, %s, %s, %s, %s, %s, %s, %s)
            RETURNING id, name, description, language, trigger_type, trigger_cron,
                      trigger_table, enabled, sandboxed, created_at, updated_at
            """,
            (
                payload.name, payload.description, payload.code,
                payload.trigger_type, payload.trigger_cron, payload.trigger_table,
                payload.enabled, payload.sandboxed,
            ),
        )
        row = dict(cur.fetchone())
    reload_jobs()
    return row


@router.put("/{script_id}")
def update_script(script_id: int, payload: ScriptUpdate):
    _validate_payload(payload)
    fields = {k: v for k, v in payload.model_dump(exclude_none=True).items()}
    if not fields:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Aucun champ à mettre à jour")
    sets = ", ".join(f"{k} = %s" for k in fields.keys()) + ", updated_at = NOW()"
    values = list(fields.values()) + [script_id]
    with get_cursor(dict_cursor=True) as (cur, _):
        cur.execute(f"UPDATE _mhp_scripts SET {sets} WHERE id = %s RETURNING *", values)
        row = cur.fetchone()
        if not row:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "Script introuvable")
        result = dict(row)
    reload_jobs()
    return result


@router.delete("/{script_id}")
def delete_script(script_id: int):
    with get_cursor() as (cur, _):
        cur.execute("DELETE FROM _mhp_scripts WHERE id = %s", (script_id,))
        if cur.rowcount == 0:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "Script introuvable")
    reload_jobs()
    return {"deleted": script_id}


# ─── Exécution & runs ────────────────────────────────────────
@router.post("/{script_id}/run")
def run_now(script_id: int):
    return run_script(script_id, triggered_by="manual")


@router.get("/{script_id}/runs")
def list_runs(script_id: int, limit: int = Query(20, ge=1, le=200)):
    with get_cursor(dict_cursor=True) as (cur, _):
        cur.execute(
            """
            SELECT id, started_at, ended_at, status, duration_ms, triggered_by,
                   LEFT(COALESCE(output,''), 500) AS output_preview,
                   LEFT(COALESCE(error,''), 500)  AS error_preview
            FROM _mhp_script_runs
            WHERE script_id = %s
            ORDER BY started_at DESC
            LIMIT %s
            """,
            (script_id, limit),
        )
        return {"runs": [dict(r) for r in cur.fetchall()]}


@router.get("/{script_id}/runs/{run_id}")
def get_run(script_id: int, run_id: int):
    with get_cursor(dict_cursor=True) as (cur, _):
        cur.execute(
            "SELECT * FROM _mhp_script_runs WHERE id = %s AND script_id = %s",
            (run_id, script_id),
        )
        row = cur.fetchone()
        if not row:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "Run introuvable")
        return dict(row)

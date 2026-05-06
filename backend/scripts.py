"""Module Scripts — CRUD + exécution sandboxée (subprocess Python avec timeout)."""
import logging
import os
import re
import subprocess
import sys
import tempfile
from datetime import datetime

from fastapi import APIRouter, HTTPException, Query, status
from pydantic import BaseModel, Field

from config import settings
from db import get_cursor

log = logging.getLogger("mhp.scripts")
router = APIRouter(prefix="/scripts", tags=["scripts"])

SCRIPT_TIMEOUT_S = 60   # Timeout par défaut d'un script
NAME_RE = re.compile(r"^[a-zA-Z0-9_\- ]{1,64}$")


# ─── Models ──────────────────────────────────────────────────
class ScriptIn(BaseModel):
    name: str = Field(..., min_length=1, max_length=64)
    description: str = ""
    code: str = ""
    trigger_type: str = "manual"   # 'manual' | 'cron'
    trigger_cron: str | None = None
    enabled: bool = True


class ScriptUpdate(BaseModel):
    name: str | None = None
    description: str | None = None
    code: str | None = None
    trigger_type: str | None = None
    trigger_cron: str | None = None
    enabled: bool | None = None


# ─── Endpoints CRUD ──────────────────────────────────────────
@router.get("")
def list_scripts():
    with get_cursor(dict_cursor=True) as (cur, _):
        cur.execute(
            "SELECT id, name, description, language, trigger_type, trigger_cron, enabled, "
            "created_at, updated_at FROM _mhp_scripts ORDER BY name"
        )
        return {"scripts": [dict(r) for r in cur.fetchall()]}


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
    if not NAME_RE.match(payload.name):
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Nom invalide (lettres/chiffres/_/-/espace, max 64)")
    if payload.trigger_type not in ("manual", "cron"):
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "trigger_type doit être 'manual' ou 'cron'")
    with get_cursor(dict_cursor=True) as (cur, _):
        cur.execute(
            """
            INSERT INTO _mhp_scripts (name, description, code, trigger_type, trigger_cron, enabled)
            VALUES (%s, %s, %s, %s, %s, %s)
            RETURNING id, name, description, language, trigger_type, trigger_cron, enabled,
                      created_at, updated_at
            """,
            (payload.name, payload.description, payload.code,
             payload.trigger_type, payload.trigger_cron, payload.enabled),
        )
        return dict(cur.fetchone())


@router.put("/{script_id}")
def update_script(script_id: int, payload: ScriptUpdate):
    fields = {k: v for k, v in payload.model_dump(exclude_none=True).items()}
    if not fields:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Aucun champ à mettre à jour")
    if "name" in fields and not NAME_RE.match(fields["name"]):
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Nom invalide")
    if "trigger_type" in fields and fields["trigger_type"] not in ("manual", "cron"):
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "trigger_type invalide")

    sets = ", ".join(f"{k} = %s" for k in fields.keys())
    sets += ", updated_at = NOW()"
    values = list(fields.values()) + [script_id]
    with get_cursor(dict_cursor=True) as (cur, _):
        cur.execute(f"UPDATE _mhp_scripts SET {sets} WHERE id = %s RETURNING *", values)
        row = cur.fetchone()
        if not row:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "Script introuvable")
        return dict(row)


@router.delete("/{script_id}")
def delete_script(script_id: int):
    with get_cursor() as (cur, _):
        cur.execute("DELETE FROM _mhp_scripts WHERE id = %s", (script_id,))
        if cur.rowcount == 0:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "Script introuvable")
        return {"deleted": script_id}


# ─── Exécution ───────────────────────────────────────────────
@router.post("/{script_id}/run")
def run_script(script_id: int, triggered_by: str = "manual"):
    """Exécute le script dans un subprocess Python isolé, avec timeout."""
    with get_cursor(dict_cursor=True) as (cur, _):
        cur.execute("SELECT id, code, enabled FROM _mhp_scripts WHERE id = %s", (script_id,))
        scr = cur.fetchone()
        if not scr:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "Script introuvable")
        if not scr["enabled"]:
            raise HTTPException(status.HTTP_400_BAD_REQUEST, "Script désactivé")

    code = scr["code"] or ""

    # Crée la run en BD (status='running')
    with get_cursor(dict_cursor=True) as (cur, _):
        cur.execute(
            "INSERT INTO _mhp_script_runs (script_id, status, triggered_by) VALUES (%s, 'running', %s) RETURNING id",
            (script_id, triggered_by),
        )
        run_id = cur.fetchone()["id"]

    # Prépare l'environnement
    env = os.environ.copy()
    env["MHP_DB_HOST"]     = settings.db_host
    env["MHP_DB_PORT"]     = str(settings.db_port)
    env["MHP_DB_NAME"]     = settings.db_name
    env["MHP_DB_USER"]     = settings.db_user
    env["MHP_DB_PASSWORD"] = settings.db_password
    # Inclut backend/ pour que `import mhp` fonctionne (mhp_lib.py est aliasé)
    backend_dir = os.path.dirname(os.path.abspath(__file__))
    env["PYTHONPATH"] = backend_dir + os.pathsep + env.get("PYTHONPATH", "")
    # Désactive l'écriture de .pyc parasites
    env["PYTHONDONTWRITEBYTECODE"] = "1"

    # Préfixe : alias `mhp` -> mhp_lib (un seul fichier dans le subprocess Python)
    full_code = (
        "import sys, importlib\n"
        "import mhp_lib as mhp\n"
        "sys.modules['mhp'] = mhp\n"
        "# ─── USER CODE ───\n"
        + code
    )

    with tempfile.NamedTemporaryFile(mode="w", suffix=".py", delete=False, encoding="utf-8") as f:
        f.write(full_code)
        tmp_path = f.name

    started = datetime.utcnow()
    output, error, status_str = "", None, "success"
    try:
        result = subprocess.run(
            [sys.executable, "-u", tmp_path],
            capture_output=True,
            text=True,
            timeout=SCRIPT_TIMEOUT_S,
            env=env,
            cwd=backend_dir,
        )
        output = (result.stdout or "")[-100_000:]   # cap à 100k chars
        if result.returncode != 0:
            status_str = "error"
            error = (result.stderr or "")[-50_000:]
    except subprocess.TimeoutExpired as e:
        status_str = "timeout"
        output = ((e.stdout or b"").decode("utf-8", errors="replace"))[-100_000:] if e.stdout else ""
        error = f"Timeout après {SCRIPT_TIMEOUT_S}s — script tué."
    except Exception as e:
        log.exception("Erreur runner script")
        status_str = "error"
        error = f"Runner error : {e}"
    finally:
        try: os.unlink(tmp_path)
        except Exception: pass

    ended = datetime.utcnow()
    duration_ms = int((ended - started).total_seconds() * 1000)

    with get_cursor() as (cur, _):
        cur.execute(
            "UPDATE _mhp_script_runs SET ended_at=%s, status=%s, output=%s, error=%s, duration_ms=%s WHERE id=%s",
            (ended, status_str, output, error, duration_ms, run_id),
        )

    return {
        "run_id": run_id,
        "status": status_str,
        "output": output,
        "error": error,
        "duration_ms": duration_ms,
    }


@router.get("/{script_id}/runs")
def list_runs(script_id: int, limit: int = Query(20, ge=1, le=200)):
    with get_cursor(dict_cursor=True) as (cur, _):
        cur.execute(
            "SELECT id, started_at, ended_at, status, duration_ms, triggered_by, "
            "LEFT(COALESCE(output,''), 500) AS output_preview, "
            "LEFT(COALESCE(error,''), 500) AS error_preview "
            "FROM _mhp_script_runs WHERE script_id = %s "
            "ORDER BY started_at DESC LIMIT %s",
            (script_id, limit),
        )
        return {"runs": [dict(r) for r in cur.fetchall()]}


@router.get("/{script_id}/runs/{run_id}")
def get_run(script_id: int, run_id: int):
    with get_cursor(dict_cursor=True) as (cur, _):
        cur.execute(
            "SELECT * FROM _mhp_script_runs WHERE id=%s AND script_id=%s",
            (run_id, script_id),
        )
        row = cur.fetchone()
        if not row:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "Run introuvable")
        return dict(row)

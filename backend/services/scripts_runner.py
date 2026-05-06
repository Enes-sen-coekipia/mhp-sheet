"""Runner de scripts utilisateur — subprocess Python isolé avec timeout.

Importé à la fois par routes/scripts.py (run-now manuel) et services/scheduler.py
(cron auto) et services/triggers.py (on-edit).
"""
import logging
import os
import subprocess
import sys
import tempfile
from datetime import datetime
from typing import Optional

from config import settings
from db import get_cursor

log = logging.getLogger("mhp.scripts.runner")

DEFAULT_TIMEOUT_S = 60
MAX_OUTPUT_CHARS  = 100_000
MAX_ERROR_CHARS   = 50_000


def _build_runner_code(user_code: str, sandboxed: bool) -> str:
    """Wrap user code with mhp lib injection. If sandboxed, run via RestrictedPython."""
    if not sandboxed:
        return (
            "import sys\n"
            "import mhp_lib as mhp\n"
            "sys.modules['mhp'] = mhp\n"
            "# ─── USER CODE ───\n"
            + user_code
        )
    # Mode sandbox : RestrictedPython compile le code utilisateur avec un
    # ensemble réduit de builtins. Empêche `__import__('os').system(...)` et
    # autres techniques d'évasion classiques. La lib `mhp` reste accessible.
    return (
        "import sys\n"
        "import mhp_lib as mhp\n"
        "sys.modules['mhp'] = mhp\n"
        "from RestrictedPython import compile_restricted, safe_globals, limited_builtins, utility_builtins\n"
        "from RestrictedPython.Guards import safer_getattr, full_write_guard\n"
        "from RestrictedPython.Eval import default_guarded_getitem, default_guarded_getiter\n"
        "user_src = '''\\\n"
        + user_code.replace("\\", "\\\\").replace("'''", r"\'\'\'") + "\n'''\n"
        "byte_code = compile_restricted(user_src, '<user_script>', 'exec')\n"
        "g = dict(safe_globals)\n"
        "g.update(utility_builtins)\n"
        "g.update(limited_builtins)\n"
        "g['mhp'] = mhp\n"
        "g['_getattr_'] = safer_getattr\n"
        "g['_getitem_'] = default_guarded_getitem\n"
        "g['_getiter_'] = default_guarded_getiter\n"
        "g['_write_'] = full_write_guard\n"
        "g['__name__'] = '__main__'\n"
        "g['print'] = print\n"
        "exec(byte_code, g)\n"
    )


def run_script(
    script_id: int,
    triggered_by: str = "manual",
    extra_env: Optional[dict] = None,
    timeout_s: int = DEFAULT_TIMEOUT_S,
) -> dict:
    """Exécute un script depuis son ID. Crée et met à jour la run en BD."""
    with get_cursor(dict_cursor=True) as (cur, _):
        cur.execute("SELECT id, code, enabled, sandboxed FROM _mhp_scripts WHERE id = %s", (script_id,))
        scr = cur.fetchone()
    if not scr:
        return {"status": "error", "error": f"Script {script_id} introuvable"}
    if not scr["enabled"]:
        log.info("Skip script %s (disabled)", script_id)
        return {"status": "skipped", "error": "Script désactivé"}

    return run_script_code(
        script_id=script_id,
        code=scr["code"] or "",
        sandboxed=bool(scr.get("sandboxed", False)),
        triggered_by=triggered_by,
        extra_env=extra_env,
        timeout_s=timeout_s,
    )


def run_script_code(
    script_id: int,
    code: str,
    sandboxed: bool = False,
    triggered_by: str = "manual",
    extra_env: Optional[dict] = None,
    timeout_s: int = DEFAULT_TIMEOUT_S,
) -> dict:
    """Cœur de l'exécution. Renvoie {run_id, status, output, error, duration_ms}."""
    with get_cursor(dict_cursor=True) as (cur, _):
        cur.execute(
            "INSERT INTO _mhp_script_runs (script_id, status, triggered_by) "
            "VALUES (%s, 'running', %s) RETURNING id",
            (script_id, triggered_by),
        )
        run_id = cur.fetchone()["id"]

    env = os.environ.copy()
    env["MHP_DB_HOST"]     = settings.db_host
    env["MHP_DB_PORT"]     = str(settings.db_port)
    env["MHP_DB_NAME"]     = settings.db_name
    env["MHP_DB_USER"]     = settings.db_user
    env["MHP_DB_PASSWORD"] = settings.db_password
    backend_dir = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    env["PYTHONPATH"] = backend_dir + os.pathsep + env.get("PYTHONPATH", "")
    env["PYTHONDONTWRITEBYTECODE"] = "1"
    if extra_env:
        env.update(extra_env)

    full_code = _build_runner_code(code, sandboxed)

    with tempfile.NamedTemporaryFile(mode="w", suffix=".py", delete=False, encoding="utf-8") as f:
        f.write(full_code)
        tmp_path = f.name

    started = datetime.utcnow()
    output, error, status_str = "", None, "success"
    try:
        result = subprocess.run(
            [sys.executable, "-u", tmp_path],
            capture_output=True, text=True,
            timeout=timeout_s, env=env, cwd=backend_dir,
        )
        output = (result.stdout or "")[-MAX_OUTPUT_CHARS:]
        if result.returncode != 0:
            status_str = "error"
            error = (result.stderr or "")[-MAX_ERROR_CHARS:]
    except subprocess.TimeoutExpired as e:
        status_str = "timeout"
        out_b = e.stdout or b""
        output = (out_b.decode("utf-8", errors="replace") if out_b else "")[-MAX_OUTPUT_CHARS:]
        error = f"Timeout après {timeout_s}s — script tué."
    except Exception as e:
        log.exception("Erreur runner")
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

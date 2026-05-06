"""Triggers on-edit / on-row-add — appelés depuis routes/data.py après écriture.

L'exécution est lancée dans un thread de fond pour ne pas bloquer la réponse HTTP.
"""
import logging
import threading
from typing import Iterable

from db import get_cursor
from services.scripts_runner import run_script

log = logging.getLogger("mhp.triggers")


def _fire_async(script_ids: Iterable[int], extra_env: dict, trigger_label: str):
    """Spawn un thread daemon pour chaque script à déclencher."""
    for sid in script_ids:
        t = threading.Thread(
            target=_safe_run,
            args=(sid, trigger_label, extra_env),
            daemon=True,
            name=f"trigger-{sid}",
        )
        t.start()


def _safe_run(script_id: int, trigger_label: str, extra_env: dict):
    try:
        run_script(script_id, triggered_by=trigger_label, extra_env=extra_env)
    except Exception as e:
        log.exception("Erreur trigger script #%s : %s", script_id, e)


def _scripts_for(trigger_type: str, table_name: str) -> list[int]:
    with get_cursor(dict_cursor=True) as (cur, _):
        cur.execute(
            "SELECT id FROM _mhp_scripts "
            "WHERE enabled = TRUE AND trigger_type = %s "
            "  AND (trigger_table = %s OR trigger_table IS NULL OR trigger_table = '')",
            (trigger_type, table_name),
        )
        return [r["id"] for r in cur.fetchall()]


def fire_on_edit(table: str, column: str, primary_val: str, old_value, new_value):
    """Appelé après une modification de cellule (PUT /cell ou /cells/batch)."""
    ids = _scripts_for("on_edit", table)
    if not ids:
        return
    extra_env = {
        "MHP_TRIGGER_TYPE": "on_edit",
        "MHP_TRIGGER_TABLE": table,
        "MHP_TRIGGER_COLUMN": column,
        "MHP_TRIGGER_PRIMARY_VAL": str(primary_val) if primary_val is not None else "",
        "MHP_TRIGGER_OLD_VALUE": "" if old_value is None else str(old_value),
        "MHP_TRIGGER_NEW_VALUE": "" if new_value is None else str(new_value),
    }
    log.info("on_edit %s.%s pk=%s → %d script(s)", table, column, primary_val, len(ids))
    _fire_async(ids, extra_env, "on_edit")


def fire_on_webhook(slug: str, webhook_id: int, headers: dict, body_json, body_raw: str):
    """Appelé après réception d'un webhook (POST /api/webhook/{slug})."""
    import json as _json
    with get_cursor(dict_cursor=True) as (cur, _):
        cur.execute(
            "SELECT id FROM _mhp_scripts "
            "WHERE enabled = TRUE AND trigger_type = 'on_webhook' "
            "  AND (trigger_webhook_slug = %s OR trigger_webhook_slug IS NULL OR trigger_webhook_slug = '')",
            (slug,),
        )
        ids = [r["id"] for r in cur.fetchall()]
    if not ids:
        return
    extra_env = {
        "MHP_TRIGGER_TYPE": "on_webhook",
        "MHP_WEBHOOK_SLUG": slug,
        "MHP_WEBHOOK_ID": str(webhook_id),
        "MHP_WEBHOOK_HEADERS": _json.dumps(headers, default=str),
        "MHP_WEBHOOK_BODY_JSON": _json.dumps(body_json, default=str) if body_json is not None else "",
        "MHP_WEBHOOK_BODY_RAW": (body_raw or "")[:50_000],  # cap pour env vars
    }
    log.info("on_webhook %s id=%s → %d script(s)", slug, webhook_id, len(ids))
    _fire_async(ids, extra_env, "on_webhook")


def fire_on_row_add(table: str, primary_val: str, row_data: dict):
    """Appelé après un INSERT (POST /table/{name}/row)."""
    ids = _scripts_for("on_row_add", table)
    if not ids:
        return
    import json as _json
    extra_env = {
        "MHP_TRIGGER_TYPE": "on_row_add",
        "MHP_TRIGGER_TABLE": table,
        "MHP_TRIGGER_PRIMARY_VAL": str(primary_val) if primary_val is not None else "",
        "MHP_TRIGGER_ROW_DATA": _json.dumps(row_data, default=str),
    }
    log.info("on_row_add %s pk=%s → %d script(s)", table, primary_val, len(ids))
    _fire_async(ids, extra_env, "on_row_add")

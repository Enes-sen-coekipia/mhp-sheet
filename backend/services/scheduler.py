"""APScheduler — déclenchement automatique des scripts à trigger='cron'.

Lifecycle :
- init_scheduler() au démarrage de l'app (lifespan)
- reload_jobs() à chaque CRUD script (CREATE/UPDATE/DELETE)
- shutdown_scheduler() à l'arrêt
"""
import logging

from apscheduler.schedulers.background import BackgroundScheduler
from apscheduler.triggers.cron import CronTrigger

from db import get_cursor
from services.scripts_runner import run_script

log = logging.getLogger("mhp.scheduler")

_scheduler: BackgroundScheduler | None = None


def init_scheduler():
    global _scheduler
    if _scheduler is not None:
        return
    _scheduler = BackgroundScheduler(timezone="Europe/Paris")
    _scheduler.start()
    reload_jobs()
    log.info("Scheduler démarré (timezone Europe/Paris)")


def shutdown_scheduler():
    global _scheduler
    if _scheduler is not None:
        _scheduler.shutdown(wait=False)
        _scheduler = None
        log.info("Scheduler arrêté")


def reload_jobs() -> int:
    """Re-charge tous les jobs cron depuis la BD. Renvoie le nb de jobs (re)programmés."""
    if _scheduler is None:
        return 0
    _scheduler.remove_all_jobs()
    n = 0
    with get_cursor(dict_cursor=True) as (cur, _):
        cur.execute(
            "SELECT id, name, trigger_cron FROM _mhp_scripts "
            "WHERE enabled = TRUE AND trigger_type = 'cron' AND trigger_cron IS NOT NULL "
            "  AND trigger_cron <> ''"
        )
        rows = cur.fetchall()
    for s in rows:
        cron = s["trigger_cron"]
        try:
            trigger = CronTrigger.from_crontab(cron, timezone="Europe/Paris")
            _scheduler.add_job(
                _run_with_logging,
                trigger=trigger,
                args=[s["id"], s["name"]],
                id=f"script_{s['id']}",
                replace_existing=True,
                coalesce=True,
                max_instances=1,
                misfire_grace_time=60,
            )
            n += 1
            log.info("Job programmé : script #%s '%s' cron='%s'", s["id"], s["name"], cron)
        except Exception as e:
            log.error("Cron invalide pour script #%s '%s' (%s) : %s", s["id"], s["name"], cron, e)
    log.info("Reload : %d job(s) cron actif(s)", n)
    return n


def _run_with_logging(script_id: int, name: str):
    """Wrapper appelé par APScheduler — exécute le script et trace."""
    log.info("⏱ Cron déclenché : script #%s '%s'", script_id, name)
    try:
        result = run_script(script_id, triggered_by="cron")
        log.info("⏱ Script #%s terminé : %s en %dms", script_id, result["status"], result["duration_ms"])
    except Exception as e:
        log.exception("⏱ Erreur cron script #%s : %s", script_id, e)


def list_scheduled_jobs() -> list[dict]:
    """Pour debug : renvoie la liste des jobs en cours."""
    if _scheduler is None:
        return []
    return [
        {
            "id": job.id,
            "next_run": job.next_run_time.isoformat() if job.next_run_time else None,
            "trigger": str(job.trigger),
        }
        for job in _scheduler.get_jobs()
    ]

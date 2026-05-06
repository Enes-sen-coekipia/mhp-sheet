"""MHP DataSheet — entry point FastAPI.

Architecture :
    main.py           → app + lifespan + middleware + mount routers
    config.py         → settings (pydantic-settings)
    db.py             → pool psycopg2 + context manager
    models.py         → schémas Pydantic partagés
    mhp_lib.py        → librairie exposée aux scripts utilisateurs (`import mhp`)
    auth.py           → HTTP Basic (réservé pour réactivation future)
    routes/           → endpoints HTTP, un router FastAPI par domaine
        data.py         tables/cells/columns/rows
        formulas.py     formules SQL par colonne
        scripts.py      module Scripts (équivalent Apps Script)
    services/         → logique métier sans HTTP
        security.py     validation des identifiants & des formules
        scripts_runner  exécution Python sandboxée (subprocess)
        scheduler.py    APScheduler pour les triggers cron auto
        triggers.py     déclencheurs on_edit / on_row_add
"""
import logging
from contextlib import asynccontextmanager

import psycopg2
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from config import settings
from db import close_pool, init_pool, ping
from routes.data import router as data_router
from routes.formulas import router as formulas_router
from routes.scripts import router as scripts_router
from services.scheduler import init_scheduler, shutdown_scheduler

logging.basicConfig(
    level=settings.log_level.upper(),
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
)
log = logging.getLogger("mhp.api")


@asynccontextmanager
async def lifespan(_: FastAPI):
    init_pool()
    try:
        ping()
        log.info("PostgreSQL reachable")
    except Exception:
        log.exception("PostgreSQL ping failed at startup")
    init_scheduler()
    yield
    shutdown_scheduler()
    close_pool()


app = FastAPI(title="MHP DataSheet API", version="2.0.0", lifespan=lifespan)

# Routers métier
app.include_router(data_router)
app.include_router(formulas_router)
app.include_router(scripts_router)

# CORS — vide par défaut (même origine via Nginx)
if settings.cors_origins:
    app.add_middleware(
        CORSMiddleware,
        allow_origins=settings.cors_origins,
        allow_credentials=True,
        allow_methods=["GET", "POST", "PUT", "DELETE"],
        allow_headers=["Authorization", "Content-Type"],
    )


@app.exception_handler(psycopg2.Error)
async def pg_error_handler(_, exc: psycopg2.Error):
    log.exception("PostgreSQL error")
    detail = getattr(exc, "diag", None)
    msg = getattr(detail, "message_primary", None) or str(exc)
    return JSONResponse(status_code=400, content={"detail": f"PostgreSQL : {msg}"})


@app.get("/health")
def health():
    try:
        ping()
        return {"status": "ok", "db": "connected"}
    except Exception as e:
        log.exception("health check failed")
        return JSONResponse(status_code=503, content={"status": "error", "db": str(e)})

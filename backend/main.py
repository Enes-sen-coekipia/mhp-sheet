import logging
from contextlib import asynccontextmanager

import psycopg2
from fastapi import FastAPI, HTTPException, Query, status
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from config import settings
from db import close_pool, get_cursor, init_pool, ping
from scripts import router as scripts_router
from models import (
    CellsBatchUpdate,
    CellUpdate,
    FormulaUpdate,
    NewColumn,
    NewRow,
)
from security import (
    normalize_new_column_name,
    validate_col_type,
    validate_column,
    validate_formula,
    validate_table,
)

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
    yield
    close_pool()


app = FastAPI(
    title="MHP DataSheet API",
    version="1.0.0",
    lifespan=lifespan,
)

app.include_router(scripts_router)

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


# ---------------------------------------------------------------------------
# Health & métadonnées
# ---------------------------------------------------------------------------

@app.get("/health")
def health():
    try:
        ping()
        return {"status": "ok", "db": "connected"}
    except Exception as e:
        log.exception("health check failed")
        return JSONResponse(status_code=503, content={"status": "error", "db": str(e)})


@app.get("/tables")
def list_tables():
    with get_cursor() as (cur, _conn):
        cur.execute(
            """
            SELECT table_name FROM information_schema.tables
            WHERE table_schema = 'public'
              AND table_type = 'BASE TABLE'
              AND table_name NOT LIKE %s
            ORDER BY table_name
            """,
            ("\\_%",),
        )
        return {"tables": [r[0] for r in cur.fetchall()]}


# ---------------------------------------------------------------------------
# Lecture
# ---------------------------------------------------------------------------

@app.get("/table/{table_name}")
def get_table(
    table_name: str,
    limit: int = Query(default=None, ge=1),
    offset: int = Query(default=0, ge=0),
):
    table = validate_table(table_name)
    effective_limit = min(limit or settings.default_page_size, settings.max_page_size)

    with get_cursor(dict_cursor=True) as (cur, _conn):
        cur.execute(
            f'SELECT * FROM "{table}" LIMIT %s OFFSET %s',
            (effective_limit, offset),
        )
        rows = [dict(r) for r in cur.fetchall()]

        cur.execute(f'SELECT COUNT(*) AS c FROM "{table}"')
        total = cur.fetchone()["c"]

        cur.execute(
            """
            SELECT column_name, data_type
            FROM information_schema.columns
            WHERE table_schema = 'public' AND table_name = %s
            ORDER BY ordinal_position
            """,
            (table,),
        )
        cols = cur.fetchall()

        cur.execute(
            "SELECT column_name FROM _mhp_formulas WHERE table_name = %s",
            (table,),
        )
        formula_cols = {r["column_name"] for r in cur.fetchall()}

    return {
        "table": table,
        "total": total,
        "limit": effective_limit,
        "offset": offset,
        "columns": [
            {
                "name": c["column_name"],
                "type": c["data_type"],
                "has_formula": c["column_name"] in formula_cols,
            }
            for c in cols
        ],
        "rows": rows,
    }


@app.get("/table/{table_name}/formulas")
def get_formulas(table_name: str):
    table = validate_table(table_name)
    with get_cursor(dict_cursor=True) as (cur, _conn):
        cur.execute(
            "SELECT column_name, formula FROM _mhp_formulas WHERE table_name = %s",
            (table,),
        )
        return {"formulas": {r["column_name"]: r["formula"] for r in cur.fetchall()}}


# ---------------------------------------------------------------------------
# Écriture cellule
# ---------------------------------------------------------------------------

@app.put("/cell")
def update_cell(payload: CellUpdate):
    table = validate_table(payload.table)
    column = validate_column(table, payload.column)
    primary = validate_column(table, payload.primary_col)

    with get_cursor() as (cur, _conn):
        cur.execute(
            f'UPDATE "{table}" SET "{column}" = %s WHERE "{primary}" = %s',
            (payload.value, payload.primary_val),
        )
        if cur.rowcount == 0:
            raise HTTPException(
                status.HTTP_404_NOT_FOUND,
                f"Aucune ligne correspondante pour {primary}={payload.primary_val!r}",
            )
        return {"updated": cur.rowcount}


@app.put("/cells/batch")
def update_cells_batch(payload: CellsBatchUpdate):
    """Apply many cell updates in a single transaction."""
    table = validate_table(payload.table)
    primary = validate_column(table, payload.primary_col)

    unique_columns = {c.column for c in payload.changes}
    valid_cols = {c: validate_column(table, c) for c in unique_columns}

    updated = 0
    with get_cursor() as (cur, _conn):
        for change in payload.changes:
            col = valid_cols[change.column]
            cur.execute(
                f'UPDATE "{table}" SET "{col}" = %s WHERE "{primary}" = %s',
                (change.value, change.primary_val),
            )
            updated += cur.rowcount
    return {"updated": updated, "submitted": len(payload.changes)}


# ---------------------------------------------------------------------------
# Lignes
# ---------------------------------------------------------------------------

@app.post("/table/{table_name}/row", status_code=status.HTTP_201_CREATED)
def insert_row(table_name: str, row: NewRow):
    table = validate_table(table_name)
    if not row.data:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Aucune donnée fournie")
    cols = [validate_column(table, c) for c in row.data.keys()]
    vals = list(row.data.values())
    cols_sql = ", ".join(f'"{c}"' for c in cols)
    placeholders = ", ".join(["%s"] * len(vals))
    with get_cursor() as (cur, _conn):
        cur.execute(
            f'INSERT INTO "{table}" ({cols_sql}) VALUES ({placeholders})',
            vals,
        )
        return {"inserted": cur.rowcount}


@app.delete("/table/{table_name}/row")
def delete_row(
    table_name: str,
    primary_col: str,
    primary_val: str,
):
    table = validate_table(table_name)
    primary = validate_column(table, primary_col)
    with get_cursor() as (cur, _conn):
        cur.execute(
            f'DELETE FROM "{table}" WHERE "{primary}" = %s',
            (primary_val,),
        )
        if cur.rowcount == 0:
            raise HTTPException(
                status.HTTP_404_NOT_FOUND,
                f"Aucune ligne pour {primary}={primary_val!r}",
            )
        return {"deleted": cur.rowcount}


# ---------------------------------------------------------------------------
# Colonnes & formules
# ---------------------------------------------------------------------------

@app.post("/table/{table_name}/column", status_code=status.HTTP_201_CREATED)
def add_column(table_name: str, col: NewColumn):
    table = validate_table(table_name)
    safe_name = normalize_new_column_name(col.name)
    col_type = validate_col_type(col.col_type)
    formula = validate_formula(col.formula) if col.formula else None

    with get_cursor() as (cur, _conn):
        cur.execute(
            f'ALTER TABLE "{table}" ADD COLUMN IF NOT EXISTS "{safe_name}" {col_type}'
        )
        if formula:
            cur.execute(
                """
                INSERT INTO _mhp_formulas (table_name, column_name, formula)
                VALUES (%s, %s, %s)
                ON CONFLICT (table_name, column_name)
                DO UPDATE SET formula = EXCLUDED.formula
                """,
                (table, safe_name, formula),
            )
            cur.execute(f'UPDATE "{table}" SET "{safe_name}" = ({formula})')

    return {"created": safe_name, "type": col_type, "formula": formula}


@app.delete("/table/{table_name}/column")
def drop_column(table_name: str, column: str):
    """Supprime une colonne. Détecte les formules SQL qui la référencent et les supprime aussi."""
    import re
    table = validate_table(table_name)
    col = validate_column(table, column)

    pattern = re.compile(r'\b' + re.escape(col) + r'\b', re.IGNORECASE)

    with get_cursor(dict_cursor=True) as (cur, _conn):
        cur.execute("SELECT table_name, column_name, formula FROM _mhp_formulas")
        all_formulas = cur.fetchall()

    affected = []
    for row in all_formulas:
        if row["table_name"] == table and row["column_name"] == col:
            continue
        if pattern.search(row["formula"] or ""):
            affected.append(f'{row["table_name"]}.{row["column_name"]}')

    with get_cursor() as (cur, _conn):
        cur.execute(f'ALTER TABLE "{table}" DROP COLUMN IF EXISTS "{col}"')
        cur.execute(
            "DELETE FROM _mhp_formulas WHERE table_name = %s AND column_name = %s",
            (table, col),
        )
        # Supprime aussi les formules dépendantes (cassées) pour éviter les #REF! silencieux
        for fq in affected:
            t_, c_ = fq.split(".", 1)
            cur.execute(
                "DELETE FROM _mhp_formulas WHERE table_name = %s AND column_name = %s",
                (t_, c_),
            )

    return {"deleted_column": col, "broken_formulas_removed": affected}


@app.delete("/table/{table_name}")
def drop_table(table_name: str):
    """Supprime une table entière. Détecte et nettoie les formules d'autres tables qui la référencent."""
    import re
    table = validate_table(table_name)

    pattern = re.compile(r'\b' + re.escape(table) + r'\b', re.IGNORECASE)

    with get_cursor(dict_cursor=True) as (cur, _conn):
        cur.execute("SELECT table_name, column_name, formula FROM _mhp_formulas WHERE table_name != %s", (table,))
        all_formulas = cur.fetchall()

    affected = []
    for row in all_formulas:
        if pattern.search(row["formula"] or ""):
            affected.append(f'{row["table_name"]}.{row["column_name"]}')

    with get_cursor() as (cur, _conn):
        cur.execute(f'DROP TABLE IF EXISTS "{table}" CASCADE')
        cur.execute("DELETE FROM _mhp_formulas WHERE table_name = %s", (table,))
        for fq in affected:
            t_, c_ = fq.split(".", 1)
            cur.execute(
                "DELETE FROM _mhp_formulas WHERE table_name = %s AND column_name = %s",
                (t_, c_),
            )

    return {"deleted_table": table, "broken_formulas_removed": affected}


@app.post("/formula/apply")
def apply_formula(payload: FormulaUpdate):
    table = validate_table(payload.table)
    column = validate_column(table, payload.column)
    formula = validate_formula(payload.formula)

    with get_cursor() as (cur, _conn):
        cur.execute(
            """
            INSERT INTO _mhp_formulas (table_name, column_name, formula)
            VALUES (%s, %s, %s)
            ON CONFLICT (table_name, column_name)
            DO UPDATE SET formula = EXCLUDED.formula
            """,
            (table, column, formula),
        )
        cur.execute(f'UPDATE "{table}" SET "{column}" = ({formula})')
        return {"updated": cur.rowcount, "formula": formula}


@app.delete("/formula")
def delete_formula(
    table: str,
    column: str,
):
    table_name = validate_table(table)
    col_name = validate_column(table_name, column)
    with get_cursor() as (cur, _conn):
        cur.execute(
            "DELETE FROM _mhp_formulas WHERE table_name = %s AND column_name = %s",
            (table_name, col_name),
        )
        return {"deleted": cur.rowcount}

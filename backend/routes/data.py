"""Endpoints CRUD sur les tables, lignes, cellules, colonnes."""
import re

from fastapi import APIRouter, HTTPException, Query, status
from pydantic import BaseModel, Field

from db import get_cursor
from models import CellsBatchUpdate, CellUpdate, NewColumn, NewRow
from services.security import (
    normalize_new_column_name,
    safe_identifier,
    validate_col_type,
    validate_column,
    validate_table,
)
from services.triggers import fire_on_edit, fire_on_row_add

router = APIRouter(tags=["data"])


# ─── Listing tables ──────────────────────────────────────────
@router.get("/tables")
def list_tables():
    with get_cursor() as (cur, _):
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


# ─── Création de table ───────────────────────────────────────
class NewTableColumn(BaseModel):
    name: str = Field(..., min_length=1, max_length=63)
    col_type: str = "TEXT"


class NewTable(BaseModel):
    name: str = Field(..., min_length=1, max_length=63)
    columns: list[NewTableColumn] = Field(..., min_length=1, max_length=200)


@router.post("/tables", status_code=status.HTTP_201_CREATED)
def create_table(payload: NewTable):
    """Crée une nouvelle table publique. Le nom est normalisé en snake_case minuscule."""
    safe_name = re.sub(r"[^a-z0-9_]", "", payload.name.strip().lower().replace(" ", "_"))
    if not safe_name or safe_name.startswith("_"):
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Nom de table invalide (préfixe '_' réservé)")
    safe_identifier(safe_name)

    cols = []
    for col in payload.columns:
        cn = normalize_new_column_name(col.name)
        ct = validate_col_type(col.col_type)
        cols.append((cn, ct))
    if len({c[0] for c in cols}) != len(cols):
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Noms de colonnes dupliqués")

    cols_sql = ", ".join(f'"{n}" {t}' for n, t in cols)
    with get_cursor() as (cur, _):
        cur.execute(
            "SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name=%s",
            (safe_name,),
        )
        if cur.fetchone():
            raise HTTPException(status.HTTP_409_CONFLICT, f"La table '{safe_name}' existe déjà")
        cur.execute(f'CREATE TABLE "{safe_name}" ({cols_sql})')

    return {"created": safe_name, "columns": [{"name": n, "type": t} for n, t in cols]}


# ─── Lecture d'une table ─────────────────────────────────────
@router.get("/table/{table_name}")
def get_table(
    table_name: str,
    limit: int = Query(default=None, ge=1),
    offset: int = Query(default=0, ge=0),
):
    from config import settings
    table = validate_table(table_name)
    effective_limit = min(limit or settings.default_page_size, settings.max_page_size)

    with get_cursor(dict_cursor=True) as (cur, _):
        cur.execute(f'SELECT * FROM "{table}" LIMIT %s OFFSET %s', (effective_limit, offset))
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

        cur.execute("SELECT column_name FROM _mhp_formulas WHERE table_name = %s", (table,))
        formula_cols = {r["column_name"] for r in cur.fetchall()}

    return {
        "table": table,
        "total": total,
        "limit": effective_limit,
        "offset": offset,
        "columns": [
            {"name": c["column_name"], "type": c["data_type"], "has_formula": c["column_name"] in formula_cols}
            for c in cols
        ],
        "rows": rows,
    }


# ─── DELETE table ────────────────────────────────────────────
@router.delete("/table/{table_name}")
def drop_table(table_name: str):
    table = validate_table(table_name)
    pattern = re.compile(r'\b' + re.escape(table) + r'\b', re.IGNORECASE)
    with get_cursor(dict_cursor=True) as (cur, _):
        cur.execute(
            "SELECT table_name, column_name, formula FROM _mhp_formulas WHERE table_name != %s",
            (table,),
        )
        all_formulas = cur.fetchall()
    affected = [
        f'{r["table_name"]}.{r["column_name"]}'
        for r in all_formulas
        if pattern.search(r["formula"] or "")
    ]
    with get_cursor() as (cur, _):
        cur.execute(f'DROP TABLE IF EXISTS "{table}" CASCADE')
        cur.execute("DELETE FROM _mhp_formulas WHERE table_name = %s", (table,))
        for fq in affected:
            t_, c_ = fq.split(".", 1)
            cur.execute(
                "DELETE FROM _mhp_formulas WHERE table_name = %s AND column_name = %s",
                (t_, c_),
            )
    return {"deleted_table": table, "broken_formulas_removed": affected}


# ─── Cellule simple ──────────────────────────────────────────
@router.put("/cell")
def update_cell(payload: CellUpdate):
    table = validate_table(payload.table)
    column = validate_column(table, payload.column)
    primary = validate_column(table, payload.primary_col)

    with get_cursor() as (cur, _):
        # Récupère ancienne valeur pour les triggers
        cur.execute(f'SELECT "{column}" FROM "{table}" WHERE "{primary}" = %s', (payload.primary_val,))
        row = cur.fetchone()
        old_value = row[0] if row else None

        cur.execute(
            f'UPDATE "{table}" SET "{column}" = %s WHERE "{primary}" = %s',
            (payload.value, payload.primary_val),
        )
        if cur.rowcount == 0:
            raise HTTPException(
                status.HTTP_404_NOT_FOUND,
                f"Aucune ligne pour {primary}={payload.primary_val!r}",
            )

    fire_on_edit(table, column, payload.primary_val, old_value, payload.value)
    return {"updated": 1}


@router.put("/cells/batch")
def update_cells_batch(payload: CellsBatchUpdate):
    table = validate_table(payload.table)
    primary = validate_column(table, payload.primary_col)
    unique_columns = {c.column for c in payload.changes}
    valid_cols = {c: validate_column(table, c) for c in unique_columns}

    updated = 0
    edits_for_triggers = []  # [(col, pk, old, new)]
    with get_cursor() as (cur, _):
        for change in payload.changes:
            col = valid_cols[change.column]
            cur.execute(
                f'SELECT "{col}" FROM "{table}" WHERE "{primary}" = %s',
                (change.primary_val,),
            )
            row = cur.fetchone()
            old_value = row[0] if row else None

            cur.execute(
                f'UPDATE "{table}" SET "{col}" = %s WHERE "{primary}" = %s',
                (change.value, change.primary_val),
            )
            updated += cur.rowcount
            if cur.rowcount > 0:
                edits_for_triggers.append((col, change.primary_val, old_value, change.value))

    for col, pk, old, new in edits_for_triggers:
        fire_on_edit(table, col, pk, old, new)
    return {"updated": updated, "submitted": len(payload.changes)}


# ─── Colonnes ────────────────────────────────────────────────
@router.post("/table/{table_name}/column", status_code=status.HTTP_201_CREATED)
def add_column(table_name: str, col: NewColumn):
    from services.security import validate_formula
    table = validate_table(table_name)
    safe_name = normalize_new_column_name(col.name)
    col_type = validate_col_type(col.col_type)
    formula = validate_formula(col.formula) if col.formula else None

    with get_cursor() as (cur, _):
        cur.execute(f'ALTER TABLE "{table}" ADD COLUMN IF NOT EXISTS "{safe_name}" {col_type}')
        if formula:
            cur.execute(
                """
                INSERT INTO _mhp_formulas (table_name, column_name, formula)
                VALUES (%s, %s, %s)
                ON CONFLICT (table_name, column_name) DO UPDATE SET formula = EXCLUDED.formula
                """,
                (table, safe_name, formula),
            )
            cur.execute(f'UPDATE "{table}" SET "{safe_name}" = ({formula})')
    return {"created": safe_name, "type": col_type, "formula": formula}


@router.delete("/table/{table_name}/column")
def drop_column(table_name: str, column: str):
    table = validate_table(table_name)
    col = validate_column(table, column)
    pattern = re.compile(r'\b' + re.escape(col) + r'\b', re.IGNORECASE)

    with get_cursor(dict_cursor=True) as (cur, _):
        cur.execute("SELECT table_name, column_name, formula FROM _mhp_formulas")
        all_formulas = cur.fetchall()

    affected = [
        f'{r["table_name"]}.{r["column_name"]}'
        for r in all_formulas
        if r["table_name"] != table or r["column_name"] != col
        if pattern.search(r["formula"] or "")
    ]

    with get_cursor() as (cur, _):
        cur.execute(f'ALTER TABLE "{table}" DROP COLUMN IF EXISTS "{col}"')
        cur.execute(
            "DELETE FROM _mhp_formulas WHERE table_name = %s AND column_name = %s",
            (table, col),
        )
        for fq in affected:
            t_, c_ = fq.split(".", 1)
            cur.execute(
                "DELETE FROM _mhp_formulas WHERE table_name = %s AND column_name = %s",
                (t_, c_),
            )
    return {"deleted_column": col, "broken_formulas_removed": affected}


# ─── Lignes ──────────────────────────────────────────────────
@router.post("/table/{table_name}/row", status_code=status.HTTP_201_CREATED)
def insert_row(table_name: str, row: NewRow):
    table = validate_table(table_name)
    if not row.data:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Aucune donnée fournie")
    cols = [validate_column(table, c) for c in row.data.keys()]
    vals = list(row.data.values())
    cols_sql = ", ".join(f'"{c}"' for c in cols)
    placeholders = ", ".join(["%s"] * len(vals))
    with get_cursor() as (cur, _):
        cur.execute(
            f'INSERT INTO "{table}" ({cols_sql}) VALUES ({placeholders})',
            vals,
        )

    pk = next(iter(row.data.values())) if row.data else None
    fire_on_row_add(table, str(pk) if pk is not None else "", dict(row.data))
    return {"inserted": 1}


@router.delete("/table/{table_name}/row")
def delete_row(table_name: str, primary_col: str, primary_val: str):
    table = validate_table(table_name)
    primary = validate_column(table, primary_col)
    with get_cursor() as (cur, _):
        cur.execute(f'DELETE FROM "{table}" WHERE "{primary}" = %s', (primary_val,))
        if cur.rowcount == 0:
            raise HTTPException(
                status.HTTP_404_NOT_FOUND,
                f"Aucune ligne pour {primary}={primary_val!r}",
            )
        return {"deleted": cur.rowcount}

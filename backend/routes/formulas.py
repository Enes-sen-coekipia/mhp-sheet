"""Endpoints sur les formules SQL par colonne (table _mhp_formulas)."""
from fastapi import APIRouter

from db import get_cursor
from models import FormulaUpdate
from services.security import validate_column, validate_formula, validate_table

router = APIRouter(tags=["formulas"])


@router.get("/table/{table_name}/formulas")
def get_formulas(table_name: str):
    table = validate_table(table_name)
    with get_cursor(dict_cursor=True) as (cur, _):
        cur.execute(
            "SELECT column_name, formula FROM _mhp_formulas WHERE table_name = %s",
            (table,),
        )
        return {"formulas": {r["column_name"]: r["formula"] for r in cur.fetchall()}}


@router.post("/formula/apply")
def apply_formula(payload: FormulaUpdate):
    table = validate_table(payload.table)
    column = validate_column(table, payload.column)
    formula = validate_formula(payload.formula)
    with get_cursor() as (cur, _):
        cur.execute(
            """
            INSERT INTO _mhp_formulas (table_name, column_name, formula)
            VALUES (%s, %s, %s)
            ON CONFLICT (table_name, column_name) DO UPDATE SET formula = EXCLUDED.formula
            """,
            (table, column, formula),
        )
        cur.execute(f'UPDATE "{table}" SET "{column}" = ({formula})')
        return {"updated": cur.rowcount, "formula": formula}


@router.delete("/formula")
def delete_formula(table: str, column: str):
    table_name = validate_table(table)
    col_name = validate_column(table_name, column)
    with get_cursor() as (cur, _):
        cur.execute(
            "DELETE FROM _mhp_formulas WHERE table_name = %s AND column_name = %s",
            (table_name, col_name),
        )
        return {"deleted": cur.rowcount}

from typing import Optional

from pydantic import BaseModel, Field


class CellUpdate(BaseModel):
    table: str
    column: str
    value: Optional[str] = None
    primary_col: str
    primary_val: str


class CellChange(BaseModel):
    column: str
    value: Optional[str] = None
    primary_val: str


class CellsBatchUpdate(BaseModel):
    table: str
    primary_col: str
    changes: list[CellChange] = Field(..., min_length=1, max_length=5000)


class NewRow(BaseModel):
    data: dict[str, Optional[str]] = Field(..., min_length=1)


class NewColumn(BaseModel):
    name: str
    col_type: str = "TEXT"
    formula: Optional[str] = None


class FormulaUpdate(BaseModel):
    table: str
    column: str
    formula: str


class ColumnInfo(BaseModel):
    name: str
    type: str
    has_formula: bool = False


class TableData(BaseModel):
    table: str
    total: int
    limit: int
    offset: int
    columns: list[ColumnInfo]
    rows: list[dict]

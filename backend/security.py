import re

from fastapi import HTTPException, status

from db import get_cursor

_IDENT_RE = re.compile(r"^[a-z_][a-z0-9_]*$")
_MAX_IDENT_LEN = 63  # PostgreSQL NAMEDATALEN - 1

# Mots-clés interdits dans les formules SQL utilisateur (write/DDL/transaction)
_FORMULA_BLACKLIST = re.compile(
    r"(?i)\b("
    r"insert|update|delete|drop|truncate|alter|create|grant|revoke|"
    r"copy|comment|vacuum|analyze|reindex|begin|commit|rollback|"
    r"savepoint|set|reset|listen|notify|do|call|prepare|execute|"
    r"lock|cluster|refresh|security|"
    r"pg_read_file|pg_ls_dir|pg_terminate_backend|pg_cancel_backend|"
    r"dblink|copy_program"
    r")\b|;|--|/\*"
)

_ALLOWED_COL_TYPES = {
    "TEXT", "VARCHAR", "CHAR",
    "INTEGER", "BIGINT", "SMALLINT", "NUMERIC", "DECIMAL", "REAL", "FLOAT",
    "DOUBLE PRECISION",
    "BOOLEAN",
    "DATE", "TIMESTAMP", "TIMESTAMPTZ", "TIME",
    "JSONB", "JSON",
}

_HIDDEN_TABLE_PREFIX = "_"


def safe_identifier(name: str) -> str:
    if not isinstance(name, str):
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Identifiant invalide")
    if not name or len(name) > _MAX_IDENT_LEN:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, f"Identifiant invalide : {name!r}")
    if not _IDENT_RE.match(name):
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST,
            f"Identifiant invalide (lettres/chiffres/_ uniquement) : {name!r}",
        )
    return name


def validate_table(table_name: str, allow_hidden: bool = False) -> str:
    """Whitelist a table name against information_schema."""
    safe_identifier(table_name)
    if not allow_hidden and table_name.startswith(_HIDDEN_TABLE_PREFIX):
        raise HTTPException(status.HTTP_404_NOT_FOUND, f"Table inconnue : {table_name}")
    with get_cursor() as (cur, _):
        cur.execute(
            """
            SELECT 1 FROM information_schema.tables
            WHERE table_schema = 'public'
              AND table_type = 'BASE TABLE'
              AND table_name = %s
            """,
            (table_name,),
        )
        if cur.fetchone() is None:
            raise HTTPException(status.HTTP_404_NOT_FOUND, f"Table inconnue : {table_name}")
    return table_name


def validate_column(table_name: str, column_name: str) -> str:
    """Whitelist a column name against information_schema for the given table."""
    safe_identifier(column_name)
    with get_cursor() as (cur, _):
        cur.execute(
            """
            SELECT 1 FROM information_schema.columns
            WHERE table_schema = 'public'
              AND table_name = %s
              AND column_name = %s
            """,
            (table_name, column_name),
        )
        if cur.fetchone() is None:
            raise HTTPException(
                status.HTTP_404_NOT_FOUND,
                f"Colonne inconnue : {table_name}.{column_name}",
            )
    return column_name


def validate_col_type(col_type: str) -> str:
    normalized = col_type.upper().strip()
    if normalized not in _ALLOWED_COL_TYPES:
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST,
            f"Type non autorisé : {col_type}",
        )
    return normalized


def validate_formula(formula: str) -> str:
    """Light sanitisation of a user-provided SQL expression.

    Auth + this regex prevent the obvious abuses (statement chaining, DDL/DML,
    dangerous functions). The SQL formula stays a powerful feature — only
    authenticated users should ever reach this code path.
    """
    if not formula or not formula.strip():
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Formule vide")
    formula = formula.strip()
    if len(formula) > 4000:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Formule trop longue (max 4000 caractères)")
    match = _FORMULA_BLACKLIST.search(formula)
    if match:
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST,
            f"Mot-clé/séquence non autorisé(e) dans la formule : {match.group(0)!r}",
        )
    return formula


def normalize_new_column_name(raw: str) -> str:
    """Normalize a user-provided column name to a safe SQL identifier."""
    if not raw:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Nom de colonne requis")
    candidate = raw.strip().lower().replace(" ", "_")
    candidate = re.sub(r"[^a-z0-9_]", "", candidate)
    if not candidate:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Nom de colonne invalide après normalisation")
    return safe_identifier(candidate)

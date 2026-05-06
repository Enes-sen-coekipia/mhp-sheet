from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        extra="ignore",
        case_sensitive=False,
    )

    db_host: str = "postgres"
    db_port: int = 5432
    db_name: str = "pilotage_mhp"
    db_user: str = "mhp_user"
    db_password: str = Field(..., min_length=1)

    # Authentification désactivée (accès libre — protège l'app au niveau réseau).
    api_username: str = ""
    api_password: str = ""

    cors_origins: list[str] = []

    log_level: str = "INFO"

    pool_min_size: int = 1
    pool_max_size: int = 10

    default_page_size: int = 500
    max_page_size: int = 5000

    # ─── OAuth Google (Gmail/Drive/Sheets) ───
    # Créer un projet GCP, activer Gmail/Drive/Sheets API, créer des credentials OAuth 2.0
    # de type "Application Web" et ajouter l'URL de callback aux URI autorisées.
    google_oauth_client_id: str = ""
    google_oauth_client_secret: str = ""
    google_oauth_redirect_uri: str = "http://localhost:3000/api/integrations/google/callback"

    # ─── Ingestion (Apps Script → notre app) ───
    # Token à fournir dans le header X-API-Token (ou ?api_token=) pour autoriser
    # les écritures via /api/table/{name}/rows ou /api/webhook/{slug}.
    # Vide = pas de protection (à éviter en prod).
    ingest_api_token: str = ""


settings = Settings()

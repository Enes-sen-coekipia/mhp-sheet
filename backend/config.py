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


settings = Settings()

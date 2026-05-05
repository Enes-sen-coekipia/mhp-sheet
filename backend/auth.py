import secrets

from fastapi import Depends, HTTPException, status
from fastapi.security import HTTPBasic, HTTPBasicCredentials

from config import settings

_security = HTTPBasic(auto_error=True)


def require_auth(credentials: HTTPBasicCredentials = Depends(_security)) -> str:
    """Constant-time check of HTTP Basic credentials against the configured user."""
    user_ok = secrets.compare_digest(
        credentials.username.encode("utf-8"),
        settings.api_username.encode("utf-8"),
    )
    pass_ok = secrets.compare_digest(
        credentials.password.encode("utf-8"),
        settings.api_password.encode("utf-8"),
    )
    if not (user_ok and pass_ok):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Identifiants invalides",
            headers={"WWW-Authenticate": 'Basic realm="MHP DataSheet"'},
        )
    return credentials.username

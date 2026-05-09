"""HTTP Basic auth with two roles: admin (full) and viewer (read-only)."""
from __future__ import annotations

import secrets
from dataclasses import dataclass
from typing import Literal

from fastapi import Depends, HTTPException, status
from fastapi.security import HTTPBasic, HTTPBasicCredentials

from .config import settings

Role = Literal["admin", "viewer"]

_security = HTTPBasic(realm="Docker Manager")


@dataclass(frozen=True)
class User:
    username: str
    role: Role


def _check(provided: str, expected: str) -> bool:
    return secrets.compare_digest(provided.encode(), expected.encode())


def authenticate(
    creds: HTTPBasicCredentials = Depends(_security),
) -> User:
    if _check(creds.username, settings.admin_user) and _check(
        creds.password, settings.admin_password
    ):
        return User(username=creds.username, role="admin")

    if (
        settings.viewer_user
        and settings.viewer_password
        and _check(creds.username, settings.viewer_user)
        and _check(creds.password, settings.viewer_password)
    ):
        return User(username=creds.username, role="viewer")

    raise HTTPException(
        status_code=status.HTTP_401_UNAUTHORIZED,
        detail="Invalid credentials",
        headers={"WWW-Authenticate": 'Basic realm="Docker Manager"'},
    )


def require_admin(user: User = Depends(authenticate)) -> User:
    if user.role != "admin":
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Admin role required for this action",
        )
    if not settings.allow_destructive:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Destructive actions are disabled (ALLOW_DESTRUCTIVE=false)",
        )
    return user

"""Per-registry credential store backed by a JSON file (mode 0600).

Credentials are used to authenticate image pulls against private registries.
The stored format is intentionally simple so it can be inspected and edited
out-of-band by operators if needed:

    {"registries": {"<name>": {"url": "...", "username": "...",
                               "password": "...", "email": "..."}}}
"""
from __future__ import annotations

import json
import os
import threading

from docker.errors import APIError
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from ..auth import User, authenticate, require_admin
from ..config import settings
from ..docker_client import get_client

router = APIRouter(prefix="/api/registries", tags=["registries"])

_LOCK = threading.Lock()


class RegistryIn(BaseModel):
    name: str = Field(..., description="Local nickname for this credential set")
    url: str = Field(
        "https://index.docker.io/v1/",
        description="Registry URL (e.g. https://ghcr.io, https://my.registry.example/v2/)",
    )
    username: str
    password: str
    email: str | None = None


class RegistryPublic(BaseModel):
    name: str
    url: str
    username: str
    email: str | None = None


def _load() -> dict:
    p = settings.registries_file
    try:
        with open(p, "r", encoding="utf-8") as fh:
            data = json.load(fh)
            return data.get("registries", {}) if isinstance(data, dict) else {}
    except FileNotFoundError:
        return {}
    except (OSError, json.JSONDecodeError):
        return {}


def _save(creds: dict) -> None:
    p = settings.registries_file
    parent = os.path.dirname(p) or "."
    try:
        os.makedirs(parent, exist_ok=True)
    except OSError as exc:
        raise HTTPException(
            status_code=500,
            detail=f"Cannot create directory for registries file: {exc}",
        ) from exc
    tmp = f"{p}.tmp"
    with open(tmp, "w", encoding="utf-8") as fh:
        json.dump({"registries": creds}, fh, indent=2)
    try:
        os.chmod(tmp, 0o600)
    except OSError:
        pass
    os.replace(tmp, p)


def get_registry_auth(name: str) -> dict | None:
    """Public helper used by the images router when pulling."""
    if not name:
        return None
    creds = _load()
    rec = creds.get(name)
    if not rec:
        return None
    out: dict = {"username": rec["username"], "password": rec["password"]}
    if rec.get("email"):
        out["email"] = rec["email"]
    if rec.get("url"):
        out["serveraddress"] = rec["url"]
    return out


@router.get("", response_model=list[RegistryPublic])
def list_registries(_: User = Depends(authenticate)) -> list[RegistryPublic]:
    with _LOCK:
        creds = _load()
    return [
        RegistryPublic(
            name=name,
            url=rec.get("url", ""),
            username=rec.get("username", ""),
            email=rec.get("email"),
        )
        for name, rec in sorted(creds.items())
    ]


@router.put("/{name}")
@router.post("")
def upsert(req: RegistryIn, name: str | None = None, _: User = Depends(require_admin)) -> dict:
    target = name or req.name
    if not target:
        raise HTTPException(status_code=400, detail="Registry name required")
    with _LOCK:
        creds = _load()
        creds[target] = {
            "url": req.url,
            "username": req.username,
            "password": req.password,
            "email": req.email,
        }
        _save(creds)
    return {"name": target, "saved": True}


@router.delete("/{name}")
def delete(name: str, _: User = Depends(require_admin)) -> dict:
    with _LOCK:
        creds = _load()
        if name not in creds:
            raise HTTPException(status_code=404, detail="Registry not found")
        del creds[name]
        _save(creds)
    return {"removed": name}


@router.post("/{name}/test")
def test_login(name: str, _: User = Depends(require_admin)) -> dict:
    with _LOCK:
        creds = _load()
    if name not in creds:
        raise HTTPException(status_code=404, detail="Registry not found")
    rec = creds[name]
    try:
        result = get_client().login(
            username=rec["username"],
            password=rec["password"],
            email=rec.get("email"),
            registry=rec.get("url") or None,
            reauth=True,
        )
        return {"ok": True, "result": result}
    except APIError as exc:
        raise HTTPException(status_code=400, detail=str(exc))

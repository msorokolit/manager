"""Volume management endpoints."""
from __future__ import annotations

from docker.errors import APIError, NotFound
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from ..auth import User, authenticate, require_admin
from ..docker_client import get_client

router = APIRouter(prefix="/api/volumes", tags=["volumes"])


class CreateVolume(BaseModel):
    name: str
    driver: str = "local"
    labels: dict[str, str] | None = None
    driver_opts: dict[str, str] | None = None


def _summary(v) -> dict:
    attrs = v.attrs or {}
    return {
        "name": v.name,
        "driver": attrs.get("Driver"),
        "mountpoint": attrs.get("Mountpoint"),
        "scope": attrs.get("Scope"),
        "created_at": attrs.get("CreatedAt"),
        "labels": attrs.get("Labels") or {},
        "options": attrs.get("Options") or {},
    }


@router.get("")
def list_volumes(_: User = Depends(authenticate)) -> list[dict]:
    try:
        return [_summary(v) for v in get_client().volumes.list()]
    except APIError as exc:
        raise HTTPException(status_code=502, detail=str(exc))


@router.get("/{name}")
def inspect_volume(name: str, _: User = Depends(authenticate)) -> dict:
    try:
        return get_client().volumes.get(name).attrs
    except NotFound:
        raise HTTPException(status_code=404, detail="Volume not found")
    except APIError as exc:
        raise HTTPException(status_code=502, detail=str(exc))


@router.post("")
def create(req: CreateVolume, _: User = Depends(require_admin)) -> dict:
    try:
        v = get_client().volumes.create(
            name=req.name,
            driver=req.driver,
            labels=req.labels or {},
            driver_opts=req.driver_opts or {},
        )
        return _summary(v)
    except APIError as exc:
        raise HTTPException(status_code=502, detail=str(exc))


@router.delete("/{name}")
def remove(name: str, force: bool = False, _: User = Depends(require_admin)) -> dict:
    try:
        get_client().volumes.get(name).remove(force=force)
        return {"removed": name}
    except NotFound:
        raise HTTPException(status_code=404, detail="Volume not found")
    except APIError as exc:
        raise HTTPException(status_code=502, detail=str(exc))


@router.post("/prune")
def prune(_: User = Depends(require_admin)) -> dict:
    try:
        return get_client().volumes.prune()
    except APIError as exc:
        raise HTTPException(status_code=502, detail=str(exc))

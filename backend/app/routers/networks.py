"""Network management endpoints."""
from __future__ import annotations

from docker.errors import APIError, NotFound
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from ..auth import User, authenticate, require_admin
from ..docker_client import get_client

router = APIRouter(prefix="/api/networks", tags=["networks"])


class CreateNetwork(BaseModel):
    name: str
    driver: str = "bridge"
    internal: bool = False
    attachable: bool = True
    labels: dict[str, str] | None = None


def _summary(n) -> dict:
    attrs = n.attrs or {}
    return {
        "id": n.id,
        "short_id": n.short_id,
        "name": n.name,
        "driver": attrs.get("Driver"),
        "scope": attrs.get("Scope"),
        "internal": attrs.get("Internal"),
        "attachable": attrs.get("Attachable"),
        "ipam": attrs.get("IPAM"),
        "labels": attrs.get("Labels") or {},
        "containers": list((attrs.get("Containers") or {}).keys()),
    }


@router.get("")
def list_networks(_: User = Depends(authenticate)) -> list[dict]:
    try:
        return [_summary(n) for n in get_client().networks.list()]
    except APIError as exc:
        raise HTTPException(status_code=502, detail=str(exc))


@router.get("/{network_id}")
def inspect_network(network_id: str, _: User = Depends(authenticate)) -> dict:
    try:
        return get_client().networks.get(network_id).attrs
    except NotFound:
        raise HTTPException(status_code=404, detail="Network not found")
    except APIError as exc:
        raise HTTPException(status_code=502, detail=str(exc))


@router.post("")
def create(req: CreateNetwork, _: User = Depends(require_admin)) -> dict:
    try:
        n = get_client().networks.create(
            name=req.name,
            driver=req.driver,
            internal=req.internal,
            attachable=req.attachable,
            labels=req.labels or {},
        )
        return _summary(n)
    except APIError as exc:
        raise HTTPException(status_code=502, detail=str(exc))


@router.delete("/{network_id}")
def remove(network_id: str, _: User = Depends(require_admin)) -> dict:
    try:
        get_client().networks.get(network_id).remove()
        return {"removed": network_id}
    except NotFound:
        raise HTTPException(status_code=404, detail="Network not found")
    except APIError as exc:
        raise HTTPException(status_code=502, detail=str(exc))


@router.post("/prune")
def prune(_: User = Depends(require_admin)) -> dict:
    try:
        return get_client().networks.prune()
    except APIError as exc:
        raise HTTPException(status_code=502, detail=str(exc))

"""System-level endpoints: info, version, df, ping."""
from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException
from docker.errors import APIError

from ..auth import User, authenticate
from ..docker_client import get_client

router = APIRouter(prefix="/api/system", tags=["system"])


@router.get("/ping")
def ping(user: User = Depends(authenticate)) -> dict:
    client = get_client()
    return {"ok": bool(client.ping()), "user": user.username, "role": user.role}


@router.get("/info")
def info(_: User = Depends(authenticate)) -> dict:
    try:
        return get_client().info()
    except APIError as exc:
        raise HTTPException(status_code=502, detail=str(exc))


@router.get("/version")
def version(_: User = Depends(authenticate)) -> dict:
    try:
        return get_client().version()
    except APIError as exc:
        raise HTTPException(status_code=502, detail=str(exc))


@router.get("/df")
def disk_usage(_: User = Depends(authenticate)) -> dict:
    try:
        return get_client().df()
    except APIError as exc:
        raise HTTPException(status_code=502, detail=str(exc))


@router.get("/events")
def events(limit: int = 25, _: User = Depends(authenticate)) -> list[dict]:
    """Return recent docker events (non-streaming, bounded)."""
    import time

    client = get_client()
    out: list[dict] = []
    try:
        end = time.time()
        start = end - 60 * 60
        for ev in client.events(since=start, until=end, decode=True):
            out.append(ev)
            if len(out) >= limit:
                break
    except APIError as exc:
        raise HTTPException(status_code=502, detail=str(exc))
    return out

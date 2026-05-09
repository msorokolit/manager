"""Image management endpoints."""
from __future__ import annotations

from typing import Iterator

from docker.errors import APIError, ImageNotFound
from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

from ..auth import User, authenticate, require_admin
from ..docker_client import get_client

router = APIRouter(prefix="/api/images", tags=["images"])


class PullRequest(BaseModel):
    repository: str
    tag: str | None = None


def _summary(img) -> dict:
    attrs = img.attrs or {}
    return {
        "id": img.id,
        "short_id": img.short_id,
        "tags": img.tags,
        "size": attrs.get("Size"),
        "created": attrs.get("Created"),
        "architecture": attrs.get("Architecture"),
        "os": attrs.get("Os"),
        "labels": (attrs.get("Config") or {}).get("Labels") or {},
    }


@router.get("")
def list_images(_: User = Depends(authenticate)) -> list[dict]:
    try:
        return [_summary(i) for i in get_client().images.list(all=False)]
    except APIError as exc:
        raise HTTPException(status_code=502, detail=str(exc))


@router.get("/{image_id:path}")
def inspect_image(image_id: str, _: User = Depends(authenticate)) -> dict:
    try:
        img = get_client().images.get(image_id)
        return img.attrs
    except ImageNotFound:
        raise HTTPException(status_code=404, detail="Image not found")
    except APIError as exc:
        raise HTTPException(status_code=502, detail=str(exc))


@router.post("/pull")
def pull(req: PullRequest, _: User = Depends(require_admin)) -> StreamingResponse:
    client = get_client()

    def gen() -> Iterator[bytes]:
        try:
            api = client.api
            for line in api.pull(req.repository, tag=req.tag, stream=True, decode=True):
                import json as _json

                yield (_json.dumps(line) + "\n").encode("utf-8")
        except APIError as exc:
            yield f'{{"error": {exc!r}}}\n'.encode()

    return StreamingResponse(gen(), media_type="application/x-ndjson")


@router.delete("/{image_id:path}")
def remove(image_id: str, force: bool = False, _: User = Depends(require_admin)) -> dict:
    try:
        get_client().images.remove(image_id, force=force)
        return {"removed": image_id}
    except ImageNotFound:
        raise HTTPException(status_code=404, detail="Image not found")
    except APIError as exc:
        raise HTTPException(status_code=502, detail=str(exc))


@router.post("/prune")
def prune(dangling_only: bool = True, _: User = Depends(require_admin)) -> dict:
    try:
        filters = {"dangling": True} if dangling_only else {}
        return get_client().images.prune(filters=filters)
    except APIError as exc:
        raise HTTPException(status_code=502, detail=str(exc))

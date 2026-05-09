"""Container management endpoints."""
from __future__ import annotations

from typing import Any, Iterator

from docker.errors import APIError, NotFound
from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field

from ..auth import User, authenticate, require_admin
from ..docker_client import get_client

router = APIRouter(prefix="/api/containers", tags=["containers"])


class CreateContainer(BaseModel):
    image: str = Field(..., description="Image reference, e.g. nginx:latest")
    name: str | None = None
    command: str | list[str] | None = None
    env: dict[str, str] | None = None
    ports: dict[str, int | str | None] | None = Field(
        default=None,
        description='Container port to host port mapping, e.g. {"80/tcp": 8080}',
    )
    volumes: dict[str, dict[str, str]] | None = Field(
        default=None,
        description='Host path -> {"bind": "/container/path", "mode": "rw"}',
    )
    restart_policy: str | None = Field(default=None, description="no|always|unless-stopped|on-failure")
    network: str | None = None
    labels: dict[str, str] | None = None
    detach: bool = True
    pull: bool = Field(default=False, description="Pull image before run")


def _summary(c: Any) -> dict:
    attrs = c.attrs or {}
    state = attrs.get("State", {}) or {}
    config = attrs.get("Config", {}) or {}
    host_config = attrs.get("HostConfig", {}) or {}
    network_settings = attrs.get("NetworkSettings", {}) or {}
    return {
        "id": c.id,
        "short_id": c.short_id,
        "name": c.name,
        "image": (c.image.tags[0] if c.image and c.image.tags else (c.image.id if c.image else None)),
        "status": c.status,
        "state": state.get("Status"),
        "health": (state.get("Health") or {}).get("Status"),
        "started_at": state.get("StartedAt"),
        "created": attrs.get("Created"),
        "restart_policy": (host_config.get("RestartPolicy") or {}).get("Name"),
        "command": config.get("Cmd"),
        "labels": config.get("Labels") or {},
        "ports": network_settings.get("Ports") or {},
        "networks": list((network_settings.get("Networks") or {}).keys()),
    }


@router.get("")
def list_containers(
    all: bool = Query(True, description="Include stopped containers"),
    _: User = Depends(authenticate),
) -> list[dict]:
    client = get_client()
    try:
        return [_summary(c) for c in client.containers.list(all=all)]
    except APIError as exc:
        raise HTTPException(status_code=502, detail=str(exc))


@router.get("/{container_id}")
def inspect_container(container_id: str, _: User = Depends(authenticate)) -> dict:
    client = get_client()
    try:
        c = client.containers.get(container_id)
        return c.attrs
    except NotFound:
        raise HTTPException(status_code=404, detail="Container not found")
    except APIError as exc:
        raise HTTPException(status_code=502, detail=str(exc))


@router.get("/{container_id}/logs")
def container_logs(
    container_id: str,
    tail: int = 200,
    timestamps: bool = False,
    _: User = Depends(authenticate),
) -> dict:
    client = get_client()
    try:
        c = client.containers.get(container_id)
        data = c.logs(tail=tail, timestamps=timestamps, stdout=True, stderr=True)
        return {"logs": data.decode("utf-8", errors="replace")}
    except NotFound:
        raise HTTPException(status_code=404, detail="Container not found")
    except APIError as exc:
        raise HTTPException(status_code=502, detail=str(exc))


@router.get("/{container_id}/logs/stream")
def container_logs_stream(
    container_id: str,
    tail: int = 100,
    _: User = Depends(authenticate),
) -> StreamingResponse:
    client = get_client()
    try:
        c = client.containers.get(container_id)
    except NotFound:
        raise HTTPException(status_code=404, detail="Container not found")

    def gen() -> Iterator[bytes]:
        try:
            for chunk in c.logs(stream=True, follow=True, tail=tail, stdout=True, stderr=True):
                if isinstance(chunk, bytes):
                    yield chunk
                else:
                    yield str(chunk).encode("utf-8", errors="replace")
        except Exception as exc:
            yield f"\n[stream ended: {exc}]\n".encode()

    return StreamingResponse(gen(), media_type="text/plain; charset=utf-8")


@router.get("/{container_id}/stats")
def container_stats(container_id: str, _: User = Depends(authenticate)) -> dict:
    client = get_client()
    try:
        c = client.containers.get(container_id)
        return c.stats(stream=False)
    except NotFound:
        raise HTTPException(status_code=404, detail="Container not found")
    except APIError as exc:
        raise HTTPException(status_code=502, detail=str(exc))


def _action(container_id: str, action: str) -> dict:
    client = get_client()
    try:
        c = client.containers.get(container_id)
        getattr(c, action)()
        c.reload()
        return _summary(c)
    except NotFound:
        raise HTTPException(status_code=404, detail="Container not found")
    except APIError as exc:
        raise HTTPException(status_code=502, detail=str(exc))


@router.post("/{container_id}/start")
def start(container_id: str, _: User = Depends(require_admin)) -> dict:
    return _action(container_id, "start")


@router.post("/{container_id}/stop")
def stop(container_id: str, _: User = Depends(require_admin)) -> dict:
    return _action(container_id, "stop")


@router.post("/{container_id}/restart")
def restart(container_id: str, _: User = Depends(require_admin)) -> dict:
    return _action(container_id, "restart")


@router.post("/{container_id}/pause")
def pause(container_id: str, _: User = Depends(require_admin)) -> dict:
    return _action(container_id, "pause")


@router.post("/{container_id}/unpause")
def unpause(container_id: str, _: User = Depends(require_admin)) -> dict:
    return _action(container_id, "unpause")


@router.post("/{container_id}/kill")
def kill(container_id: str, _: User = Depends(require_admin)) -> dict:
    return _action(container_id, "kill")


@router.delete("/{container_id}")
def remove(
    container_id: str,
    force: bool = False,
    volumes: bool = False,
    _: User = Depends(require_admin),
) -> dict:
    client = get_client()
    try:
        c = client.containers.get(container_id)
        c.remove(force=force, v=volumes)
        return {"removed": container_id}
    except NotFound:
        raise HTTPException(status_code=404, detail="Container not found")
    except APIError as exc:
        raise HTTPException(status_code=502, detail=str(exc))


@router.post("")
def create_and_run(req: CreateContainer, _: User = Depends(require_admin)) -> dict:
    client = get_client()
    try:
        if req.pull:
            client.images.pull(req.image)

        kwargs: dict[str, Any] = {
            "image": req.image,
            "detach": req.detach,
        }
        if req.name:
            kwargs["name"] = req.name
        if req.command:
            kwargs["command"] = req.command
        if req.env:
            kwargs["environment"] = req.env
        if req.ports:
            kwargs["ports"] = req.ports
        if req.volumes:
            kwargs["volumes"] = req.volumes
        if req.restart_policy:
            kwargs["restart_policy"] = {"Name": req.restart_policy}
        if req.network:
            kwargs["network"] = req.network
        if req.labels:
            kwargs["labels"] = req.labels

        c = client.containers.run(**kwargs)
        if not req.detach:
            return {"output": (c if isinstance(c, (bytes, str)) else b"").decode("utf-8", errors="replace")}
        c.reload()
        return _summary(c)
    except APIError as exc:
        raise HTTPException(status_code=502, detail=str(exc))


@router.post("/prune")
def prune(_: User = Depends(require_admin)) -> dict:
    try:
        return get_client().containers.prune()
    except APIError as exc:
        raise HTTPException(status_code=502, detail=str(exc))

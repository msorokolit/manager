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


class Ulimit(BaseModel):
    name: str
    soft: int | None = None
    hard: int | None = None


class HealthcheckSpec(BaseModel):
    test: list[str] | str | None = None
    interval: int | None = Field(None, description="Nanoseconds")
    timeout: int | None = Field(None, description="Nanoseconds")
    retries: int | None = None
    start_period: int | None = Field(None, description="Nanoseconds")


class CreateContainer(BaseModel):
    image: str = Field(..., description="Image reference, e.g. nginx:latest")
    name: str | None = None
    command: str | list[str] | None = None
    entrypoint: str | list[str] | None = None
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
    network_mode: str | None = Field(None, description="bridge|host|none|container:<id>|<name>")
    labels: dict[str, str] | None = None
    detach: bool = True
    pull: bool = Field(default=False, description="Pull image before run")

    user: str | None = None
    working_dir: str | None = None
    hostname: str | None = None
    domainname: str | None = None
    init: bool | None = None
    stop_signal: str | None = None
    stop_grace_period: int | None = Field(None, description="Seconds")
    tty: bool | None = None
    stdin_open: bool | None = None
    auto_remove: bool | None = None
    read_only: bool | None = None

    dns: list[str] | None = None
    dns_search: list[str] | None = None
    dns_opt: list[str] | None = None
    extra_hosts: dict[str, str] | None = Field(
        None, description='Hostname -> IP, e.g. {"db": "10.0.0.5"}'
    )
    mac_address: str | None = None

    tmpfs: dict[str, str] | None = Field(
        None, description='Container path -> mount opts, e.g. {"/run": "size=64m"}'
    )

    cpus: float | None = Field(None, description='Equivalent of --cpus, e.g. 1.5')
    cpu_shares: int | None = None
    cpuset_cpus: str | None = Field(None, description='e.g. "0,2-3"')
    mem_limit: str | int | None = Field(None, description='e.g. "512m" or bytes')
    mem_reservation: str | int | None = None
    memswap_limit: str | int | None = None
    pids_limit: int | None = None
    shm_size: str | int | None = None
    ulimits: list[Ulimit] | None = None
    devices: list[str] | None = Field(
        None, description='Each: "/host/dev:/container/dev[:rwm]"'
    )
    gpus: int | str | None = Field(
        None, description='-1 or "all" for every GPU; positive int for a count'
    )

    privileged: bool | None = None
    cap_add: list[str] | None = None
    cap_drop: list[str] | None = None
    security_opt: list[str] | None = None
    sysctls: dict[str, str] | None = None

    healthcheck: HealthcheckSpec | None = None

    log_driver: str | None = None
    log_opts: dict[str, str] | None = None


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


@router.get("/{container_id}/stats/stream")
def container_stats_stream(
    container_id: str, _: User = Depends(authenticate)
) -> StreamingResponse:
    import json

    client = get_client()
    try:
        c = client.containers.get(container_id)
    except NotFound:
        raise HTTPException(status_code=404, detail="Container not found")

    stream = c.stats(stream=True, decode=True)

    def gen() -> Iterator[bytes]:
        try:
            for sample in stream:
                yield (json.dumps(sample) + "\n").encode("utf-8")
        except GeneratorExit:
            return
        except Exception as exc:
            yield (json.dumps({"error": str(exc)}) + "\n").encode("utf-8")
        finally:
            try:
                stream.close()
            except Exception:
                pass

    return StreamingResponse(gen(), media_type="application/x-ndjson")


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


def _build_run_kwargs(req: CreateContainer) -> dict[str, Any]:
    from docker.types import DeviceRequest, Healthcheck, LogConfig
    from docker.types import Ulimit as DUlimit

    k: dict[str, Any] = {"image": req.image, "detach": req.detach}

    for src, dst in [
        ("name", "name"),
        ("command", "command"),
        ("entrypoint", "entrypoint"),
        ("env", "environment"),
        ("ports", "ports"),
        ("volumes", "volumes"),
        ("network", "network"),
        ("network_mode", "network_mode"),
        ("labels", "labels"),
        ("user", "user"),
        ("working_dir", "working_dir"),
        ("hostname", "hostname"),
        ("domainname", "domainname"),
        ("init", "init"),
        ("stop_signal", "stop_signal"),
        ("tty", "tty"),
        ("stdin_open", "stdin_open"),
        ("auto_remove", "auto_remove"),
        ("read_only", "read_only"),
        ("dns", "dns"),
        ("dns_search", "dns_search"),
        ("dns_opt", "dns_opt"),
        ("extra_hosts", "extra_hosts"),
        ("mac_address", "mac_address"),
        ("tmpfs", "tmpfs"),
        ("cpu_shares", "cpu_shares"),
        ("cpuset_cpus", "cpuset_cpus"),
        ("mem_limit", "mem_limit"),
        ("mem_reservation", "mem_reservation"),
        ("memswap_limit", "memswap_limit"),
        ("pids_limit", "pids_limit"),
        ("shm_size", "shm_size"),
        ("devices", "devices"),
        ("privileged", "privileged"),
        ("cap_add", "cap_add"),
        ("cap_drop", "cap_drop"),
        ("security_opt", "security_opt"),
        ("sysctls", "sysctls"),
    ]:
        v = getattr(req, src)
        if v not in (None, [], {}, ""):
            k[dst] = v

    if req.restart_policy:
        k["restart_policy"] = {"Name": req.restart_policy}
    if req.stop_grace_period is not None:
        k["stop_timeout"] = int(req.stop_grace_period)
    if req.cpus is not None:
        k["nano_cpus"] = int(float(req.cpus) * 1_000_000_000)
    if req.ulimits:
        k["ulimits"] = [
            DUlimit(name=u.name, soft=u.soft, hard=u.hard) for u in req.ulimits
        ]
    if req.gpus not in (None, 0, ""):
        count = -1 if str(req.gpus).lower() in ("all", "-1") else int(req.gpus)
        k["device_requests"] = [
            DeviceRequest(count=count, capabilities=[["gpu"]])
        ]
    if req.healthcheck:
        hc: dict[str, Any] = {}
        if req.healthcheck.test is not None:
            hc["test"] = (
                req.healthcheck.test
                if isinstance(req.healthcheck.test, list)
                else ["CMD-SHELL", req.healthcheck.test]
            )
        for f in ("interval", "timeout", "retries", "start_period"):
            v = getattr(req.healthcheck, f)
            if v is not None:
                hc[f] = v
        k["healthcheck"] = Healthcheck(**hc) if hc else None
    if req.log_driver:
        k["log_config"] = LogConfig(type=req.log_driver, config=req.log_opts or {})

    return k


@router.post("")
def create_and_run(req: CreateContainer, _: User = Depends(require_admin)) -> dict:
    client = get_client()
    try:
        if req.pull:
            client.images.pull(req.image)
        kwargs = _build_run_kwargs(req)
        c = client.containers.run(**kwargs)
        if not req.detach:
            return {
                "output": (c if isinstance(c, (bytes, str)) else b"").decode(
                    "utf-8", errors="replace"
                )
            }
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

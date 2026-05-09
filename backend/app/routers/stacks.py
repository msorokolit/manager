"""Docker Compose stack management.

Stacks live on disk as ``$STACKS_DIR/<name>/{docker-compose.yml,.env}``.
Compose projects already running on the host (containers carrying
``com.docker.compose.project`` labels) are also surfaced as "external" stacks
so they can be inspected even if the YAML isn't stored here.
"""
from __future__ import annotations

import os
import re
import shutil
import subprocess
from typing import Iterator

from docker.errors import APIError
from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field

from ..auth import User, authenticate, require_admin
from ..config import settings
from ..docker_client import get_client

router = APIRouter(prefix="/api/stacks", tags=["stacks"])

_NAME_RE = re.compile(r"^[a-zA-Z0-9][a-zA-Z0-9_-]{0,62}$")
COMPOSE_FILENAME = "docker-compose.yml"
ENV_FILENAME = ".env"


class StackCreate(BaseModel):
    name: str = Field(..., description="Lowercase letters, numbers, '-' and '_'")
    compose: str = Field(..., description="Contents of docker-compose.yml")
    env: str | None = Field(None, description="Optional .env file contents")
    deploy: bool = Field(True, description="Run `up -d` immediately after writing the files")


class StackUpdate(BaseModel):
    compose: str | None = None
    env: str | None = None


def _validate_name(name: str) -> str:
    if not _NAME_RE.match(name):
        raise HTTPException(
            status_code=400,
            detail="Invalid stack name. Use letters, digits, '-' and '_' (1-63 chars).",
        )
    return name


def _stack_dir(name: str) -> str:
    name = _validate_name(name)
    base = os.path.abspath(settings.stacks_dir)
    target = os.path.abspath(os.path.join(base, name))
    if not target.startswith(base + os.sep) and target != base:
        raise HTTPException(status_code=400, detail="Invalid stack path")
    return target


def _ensure_root(write: bool = False) -> bool:
    """Try to create the stacks directory. Returns True if it now exists.

    Read endpoints pass ``write=False`` and tolerate a missing directory
    (just no managed stacks); write endpoints raise 500 if the dir is
    inaccessible so the operator gets a clear error message.
    """
    try:
        os.makedirs(settings.stacks_dir, exist_ok=True)
        return True
    except OSError as exc:
        if write:
            raise HTTPException(
                status_code=500,
                detail=f"Cannot create STACKS_DIR ({settings.stacks_dir}): {exc}",
            ) from exc
        return os.path.isdir(settings.stacks_dir)


def _is_managed(name: str) -> bool:
    try:
        return os.path.isfile(os.path.join(_stack_dir(name), COMPOSE_FILENAME))
    except HTTPException:
        return False


def _discover() -> dict[str, list]:
    """Return {project_name: [container_summaries]} from running containers."""
    out: dict[str, list] = {}
    try:
        for c in get_client().containers.list(all=True):
            labels = c.labels or {}
            project = labels.get("com.docker.compose.project")
            if not project:
                continue
            out.setdefault(project, []).append(
                {
                    "id": c.id,
                    "name": c.name,
                    "service": labels.get("com.docker.compose.service"),
                    "status": c.status,
                    "image": (c.image.tags[0] if c.image and c.image.tags else None),
                }
            )
    except APIError:
        pass
    return out


def _stack_summary(name: str, discovered: dict[str, list]) -> dict:
    containers = discovered.get(name, [])
    services = sorted({c["service"] for c in containers if c.get("service")})
    return {
        "name": name,
        "managed": _is_managed(name),
        "services": services,
        "containers": len(containers),
        "running": sum(1 for c in containers if c.get("status") == "running"),
    }


@router.get("")
def list_stacks(_: User = Depends(authenticate)) -> list[dict]:
    _ensure_root()
    discovered = _discover()
    managed_names: set[str] = set()
    if os.path.isdir(settings.stacks_dir):
        for entry in os.listdir(settings.stacks_dir):
            full = os.path.join(settings.stacks_dir, entry)
            if os.path.isfile(os.path.join(full, COMPOSE_FILENAME)):
                managed_names.add(entry)
    names = sorted(managed_names | set(discovered.keys()))
    return [_stack_summary(n, discovered) for n in names]


@router.get("/{name}")
def get_stack(name: str, _: User = Depends(authenticate)) -> dict:
    _validate_name(name)
    discovered = _discover()
    summary = _stack_summary(name, discovered)
    compose: str | None = None
    env: str | None = None
    if summary["managed"]:
        compose_path = os.path.join(_stack_dir(name), COMPOSE_FILENAME)
        env_path = os.path.join(_stack_dir(name), ENV_FILENAME)
        with open(compose_path, "r", encoding="utf-8") as fh:
            compose = fh.read()
        if os.path.isfile(env_path):
            with open(env_path, "r", encoding="utf-8") as fh:
                env = fh.read()
    elif name not in discovered:
        raise HTTPException(status_code=404, detail="Stack not found")
    return {
        **summary,
        "compose": compose,
        "env": env,
        "containers_detail": discovered.get(name, []),
    }


def _write_stack(name: str, compose: str, env: str | None) -> str:
    _validate_name(name)
    _ensure_root()
    target = _stack_dir(name)
    os.makedirs(target, exist_ok=True)
    compose_path = os.path.join(target, COMPOSE_FILENAME)
    with open(compose_path, "w", encoding="utf-8") as fh:
        fh.write(compose)
    env_path = os.path.join(target, ENV_FILENAME)
    if env is not None:
        with open(env_path, "w", encoding="utf-8") as fh:
            fh.write(env)
    elif os.path.isfile(env_path):
        os.remove(env_path)
    return target


def _compose_argv(name: str, *args: str) -> tuple[list[str], str]:
    target = _stack_dir(name)
    compose_path = os.path.join(target, COMPOSE_FILENAME)
    if not os.path.isfile(compose_path):
        raise HTTPException(status_code=404, detail=f"No compose file for stack '{name}'")
    argv = [settings.compose_bin, "-p", name, "-f", compose_path]
    env_path = os.path.join(target, ENV_FILENAME)
    if os.path.isfile(env_path):
        argv.extend(["--env-file", env_path])
    argv.extend(args)
    return argv, target


def _stream_compose(name: str, *args: str) -> StreamingResponse:
    argv, cwd = _compose_argv(name, *args)

    def gen() -> Iterator[bytes]:
        try:
            proc = subprocess.Popen(
                argv,
                cwd=cwd,
                stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT,
                bufsize=1,
                text=False,
            )
        except FileNotFoundError:
            yield b"ERROR: docker-compose binary not found.\n"
            return
        try:
            assert proc.stdout is not None
            yield f"$ {' '.join(argv)}\n".encode()
            for line in iter(proc.stdout.readline, b""):
                yield line
            proc.wait()
            yield f"\n[exit {proc.returncode}]\n".encode()
        finally:
            try:
                proc.stdout.close()  # type: ignore[union-attr]
            except Exception:
                pass

    return StreamingResponse(gen(), media_type="text/plain; charset=utf-8")


@router.post("")
def create_stack(req: StackCreate, _: User = Depends(require_admin)):
    _validate_name(req.name)
    _ensure_root(write=True)
    if _is_managed(req.name):
        raise HTTPException(status_code=409, detail=f"Stack '{req.name}' already exists")
    _write_stack(req.name, req.compose, req.env)
    if req.deploy:
        return _stream_compose(req.name, "up", "-d")
    return {"name": req.name, "deployed": False}


@router.put("/{name}")
def update_stack(name: str, req: StackUpdate, _: User = Depends(require_admin)) -> dict:
    if not _is_managed(name):
        raise HTTPException(status_code=404, detail="Stack not found (or not managed)")
    target = _stack_dir(name)
    if req.compose is not None:
        with open(os.path.join(target, COMPOSE_FILENAME), "w", encoding="utf-8") as fh:
            fh.write(req.compose)
    if req.env is not None:
        with open(os.path.join(target, ENV_FILENAME), "w", encoding="utf-8") as fh:
            fh.write(req.env)
    return {"name": name, "updated": True}


@router.post("/{name}/up")
def up(name: str, _: User = Depends(require_admin)) -> StreamingResponse:
    return _stream_compose(name, "up", "-d", "--remove-orphans")


@router.post("/{name}/down")
def down(name: str, volumes: bool = False, _: User = Depends(require_admin)) -> StreamingResponse:
    args = ["down", "--remove-orphans"]
    if volumes:
        args.append("-v")
    return _stream_compose(name, *args)


@router.post("/{name}/restart")
def restart(name: str, _: User = Depends(require_admin)) -> StreamingResponse:
    return _stream_compose(name, "restart")


@router.post("/{name}/pull")
def pull(name: str, _: User = Depends(require_admin)) -> StreamingResponse:
    return _stream_compose(name, "pull")


@router.get("/{name}/logs")
def logs(name: str, tail: int = 200, _: User = Depends(authenticate)) -> StreamingResponse:
    return _stream_compose(name, "logs", "--no-color", "--tail", str(max(1, min(tail, 5000))))


@router.delete("/{name}")
def delete_stack(name: str, _: User = Depends(require_admin)) -> dict:
    if not _is_managed(name):
        raise HTTPException(status_code=404, detail="Stack not found (or not managed)")
    target = _stack_dir(name)
    argv, cwd = _compose_argv(name, "down", "--remove-orphans")
    try:
        subprocess.run(argv, cwd=cwd, capture_output=True, timeout=300, check=False)
    except (FileNotFoundError, subprocess.TimeoutExpired):
        pass
    shutil.rmtree(target, ignore_errors=True)
    return {"removed": name}

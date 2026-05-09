"""Lazy singleton wrapper around docker.DockerClient."""
from __future__ import annotations

import threading
from typing import Optional

import docker
from docker import DockerClient
from docker.errors import DockerException
from fastapi import HTTPException, status

from .config import settings

_lock = threading.Lock()
_client: Optional[DockerClient] = None


def get_client() -> DockerClient:
    global _client
    with _lock:
        if _client is None:
            try:
                if settings.docker_host:
                    _client = docker.DockerClient(base_url=settings.docker_host)
                else:
                    _client = docker.from_env()
                _client.ping()
            except DockerException as exc:
                raise HTTPException(
                    status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
                    detail=f"Cannot connect to Docker daemon: {exc}",
                ) from exc
        return _client


def reset_client() -> None:
    """Force the client to be re-created on next access (useful after errors)."""
    global _client
    with _lock:
        if _client is not None:
            try:
                _client.close()
            except Exception:
                pass
        _client = None

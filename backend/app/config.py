"""Runtime configuration loaded from environment variables."""
from __future__ import annotations

import os
from dataclasses import dataclass


def _bool(name: str, default: bool = False) -> bool:
    raw = os.getenv(name)
    if raw is None:
        return default
    return raw.strip().lower() in {"1", "true", "yes", "on"}


@dataclass(frozen=True)
class Settings:
    admin_user: str
    admin_password: str
    viewer_user: str | None
    viewer_password: str | None
    docker_host: str | None
    allow_destructive: bool
    cors_origins: list[str]
    static_dir: str
    log_tail_default: int
    stacks_dir: str
    compose_bin: str
    exec_default_shell: str

    @classmethod
    def from_env(cls) -> "Settings":
        cors = os.getenv("CORS_ORIGINS", "").strip()
        origins = [o.strip() for o in cors.split(",") if o.strip()] if cors else []
        return cls(
            admin_user=os.getenv("ADMIN_USER", "admin"),
            admin_password=os.getenv("ADMIN_PASSWORD", "admin"),
            viewer_user=os.getenv("VIEWER_USER") or None,
            viewer_password=os.getenv("VIEWER_PASSWORD") or None,
            docker_host=os.getenv("DOCKER_HOST") or None,
            allow_destructive=_bool("ALLOW_DESTRUCTIVE", True),
            cors_origins=origins,
            static_dir=os.getenv("STATIC_DIR", os.path.abspath(
                os.path.join(os.path.dirname(__file__), "..", "..", "frontend")
            )),
            log_tail_default=int(os.getenv("LOG_TAIL_DEFAULT", "200")),
            stacks_dir=os.getenv("STACKS_DIR", "/data/stacks"),
            compose_bin=os.getenv("COMPOSE_BIN", "docker-compose"),
            exec_default_shell=os.getenv("EXEC_DEFAULT_SHELL", "/bin/sh"),
        )


settings = Settings.from_env()

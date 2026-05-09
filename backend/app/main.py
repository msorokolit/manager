"""FastAPI application entrypoint for the Docker Manager UI."""
from __future__ import annotations

import os

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles

from . import __version__
from .config import settings
from .routers import (
    containers,
    exec as exec_router,
    images,
    networks,
    registries,
    stacks,
    system,
    volume_browser,
    volumes,
)

app = FastAPI(
    title="Docker Manager",
    version=__version__,
    description="A web UI for managing enterprise systems running in Docker.",
)

if settings.cors_origins:
    app.add_middleware(
        CORSMiddleware,
        allow_origins=settings.cors_origins,
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )

app.include_router(system.router)
app.include_router(containers.router)
app.include_router(images.router)
app.include_router(networks.router)
app.include_router(volumes.router)
app.include_router(stacks.router)
app.include_router(registries.router)
app.include_router(volume_browser.router)
app.include_router(exec_router.router)


@app.get("/api/health", tags=["meta"])
def health() -> dict:
    return {"status": "ok", "version": __version__}


@app.get("/api/config", tags=["meta"])
def public_config() -> dict:
    import shutil as _shutil

    return {
        "version": __version__,
        "allow_destructive": settings.allow_destructive,
        "compose_available": _shutil.which(settings.compose_bin) is not None,
        "stacks_dir": settings.stacks_dir,
        "exec_default_shell": settings.exec_default_shell,
        "browser_image": settings.browser_image,
        "registries_file": settings.registries_file,
    }


_static_dir = settings.static_dir
if os.path.isdir(_static_dir):
    app.mount(
        "/assets",
        StaticFiles(directory=_static_dir),
        name="assets",
    )

    @app.get("/", include_in_schema=False, response_model=None)
    def index():
        return FileResponse(os.path.join(_static_dir, "index.html"))

    @app.get("/{full_path:path}", include_in_schema=False, response_model=None)
    def spa_fallback(full_path: str):
        if full_path.startswith("api/"):
            return JSONResponse({"detail": "Not Found"}, status_code=404)
        candidate = os.path.join(_static_dir, full_path)
        if os.path.isfile(candidate) and os.path.commonpath([
            os.path.abspath(candidate), os.path.abspath(_static_dir)
        ]) == os.path.abspath(_static_dir):
            return FileResponse(candidate)
        return FileResponse(os.path.join(_static_dir, "index.html"))

"""In-browser file browser for docker volumes.

A small "sidecar" container is spun up on demand with the target volume
mounted at ``/target``. The sidecar runs a minimal Python image so we can
exec a tiny script that returns directory listings as JSON, plus use
``get_archive`` / ``put_archive`` for safe file IO.

The sidecar is reused across requests to amortise the start-up cost; it has
no network attached and is removed by ``POST /api/volumes/{name}/browse/stop``
(or by container prune at the operator's discretion). On manager start any
stale sidecars (label ``com.docker.manager.role=volume-browser``) are removed.
"""
from __future__ import annotations

import io
import json
import os
import posixpath
import tarfile
from typing import Iterator

from docker.errors import APIError, NotFound
from fastapi import APIRouter, Depends, File, HTTPException, Query, UploadFile
from fastapi.responses import StreamingResponse

from ..auth import User, authenticate, require_admin
from ..config import settings
from ..docker_client import get_client

router = APIRouter(prefix="/api/volumes", tags=["volume-browser"])

BROWSER_LABEL = "com.docker.manager.role"
BROWSER_LABEL_VAL = "volume-browser"
BROWSER_VOL_LABEL = "com.docker.manager.volume"

LIST_SCRIPT = r"""
import os, stat, sys, json
p = sys.argv[1]
out = []
try:
    entries = sorted(os.listdir(p))
except Exception as e:
    print(json.dumps({"error": str(e)}))
    sys.exit(0)
for n in entries:
    f = os.path.join(p, n)
    try:
        st = os.lstat(f)
    except OSError:
        continue
    out.append({
        "name": n,
        "is_dir": stat.S_ISDIR(st.st_mode),
        "is_link": stat.S_ISLNK(st.st_mode),
        "size": st.st_size,
        "mode": st.st_mode,
        "mtime": st.st_mtime,
    })
print(json.dumps(out))
"""


def _browser_name(volume: str) -> str:
    safe = "".join(c for c in volume if c.isalnum() or c in "-_") or "vol"
    return f"docker-manager-browser-{safe}"


def _safe_path(rel: str) -> str:
    """Normalise a user-supplied path to a guaranteed sub-path of /target."""
    rel = (rel or "").strip()
    cleaned = posixpath.normpath(posixpath.join("/target", rel.lstrip("/")))
    if cleaned != "/target" and not cleaned.startswith("/target/"):
        raise HTTPException(status_code=400, detail="Invalid path")
    return cleaned


def _ensure_browser(volume: str):
    client = get_client()
    name = _browser_name(volume)
    try:
        try:
            get_client().volumes.get(volume)
        except NotFound:
            raise HTTPException(status_code=404, detail="Volume not found")

        try:
            c = client.containers.get(name)
            if c.status != "running":
                c.start()
            return c
        except NotFound:
            pass

        try:
            client.images.get(settings.browser_image)
        except NotFound:
            client.images.pull(settings.browser_image)

        c = client.containers.run(
            settings.browser_image,
            name=name,
            command=["sleep", "infinity"],
            volumes={volume: {"bind": "/target", "mode": "rw"}},
            detach=True,
            auto_remove=False,
            network_mode="none",
            labels={BROWSER_LABEL: BROWSER_LABEL_VAL, BROWSER_VOL_LABEL: volume},
        )
        return c
    except APIError as exc:
        raise HTTPException(status_code=502, detail=str(exc))


@router.get("/{name}/browse/list")
def list_dir(
    name: str,
    path: str = Query(""),
    _: User = Depends(authenticate),
) -> dict:
    safe = _safe_path(path)
    c = _ensure_browser(name)
    try:
        result = c.exec_run(
            ["python3", "-c", LIST_SCRIPT, safe],
            stdout=True,
            stderr=True,
        )
    except APIError as exc:
        raise HTTPException(status_code=502, detail=str(exc))
    out = (result.output or b"").decode("utf-8", errors="replace").strip()
    if result.exit_code != 0:
        raise HTTPException(status_code=500, detail=out or "exec failed")
    try:
        data = json.loads(out)
    except json.JSONDecodeError:
        raise HTTPException(status_code=500, detail=f"Bad list output: {out[:200]}")
    if isinstance(data, dict) and "error" in data:
        raise HTTPException(status_code=400, detail=data["error"])
    return {"path": safe[len("/target"):] or "/", "entries": data}


@router.get("/{name}/browse/file")
def get_file(
    name: str,
    path: str = Query(...),
    _: User = Depends(authenticate),
) -> StreamingResponse:
    safe = _safe_path(path)
    if safe == "/target":
        raise HTTPException(status_code=400, detail="Cannot download root")
    c = _ensure_browser(name)
    try:
        bits, _stat = c.get_archive(safe)
    except NotFound:
        raise HTTPException(status_code=404, detail="File not found")
    except APIError as exc:
        raise HTTPException(status_code=502, detail=str(exc))

    buf = io.BytesIO()
    for chunk in bits:
        buf.write(chunk)
    buf.seek(0)

    try:
        tf = tarfile.open(fileobj=buf, mode="r")
        member = tf.next()
    except tarfile.TarError as exc:
        raise HTTPException(status_code=500, detail=f"Bad archive: {exc}")
    if member is None:
        raise HTTPException(status_code=404, detail="Empty archive")
    if not member.isfile():
        raise HTTPException(status_code=400, detail="Not a regular file")

    extracted = tf.extractfile(member)
    if extracted is None:
        raise HTTPException(status_code=500, detail="Could not extract file")
    payload = extracted.read()
    fname = posixpath.basename(safe)

    def iter_payload() -> Iterator[bytes]:
        yield payload

    return StreamingResponse(
        iter_payload(),
        media_type="application/octet-stream",
        headers={
            "Content-Disposition": f'attachment; filename="{fname}"',
            "Content-Length": str(len(payload)),
        },
    )


@router.post("/{name}/browse/file")
async def upload_file(
    name: str,
    path: str = Query("", description="Target directory inside the volume"),
    file: UploadFile = File(...),
    _: User = Depends(require_admin),
) -> dict:
    safe = _safe_path(path)
    c = _ensure_browser(name)
    data = await file.read()

    fname = posixpath.basename(file.filename or "uploaded")
    if not fname:
        raise HTTPException(status_code=400, detail="Missing filename")

    buf = io.BytesIO()
    tf = tarfile.open(fileobj=buf, mode="w")
    info = tarfile.TarInfo(name=fname)
    info.size = len(data)
    info.mode = 0o644
    tf.addfile(info, io.BytesIO(data))
    tf.close()
    buf.seek(0)

    try:
        ok = c.put_archive(safe, buf.getvalue())
    except APIError as exc:
        raise HTTPException(status_code=502, detail=str(exc))
    if not ok:
        raise HTTPException(status_code=500, detail="put_archive returned False")
    return {"uploaded": fname, "size": len(data), "path": safe[len("/target"):] or "/"}


@router.post("/{name}/browse/mkdir")
def mkdir(
    name: str,
    path: str = Query(...),
    _: User = Depends(require_admin),
) -> dict:
    safe = _safe_path(path)
    if safe == "/target":
        raise HTTPException(status_code=400, detail="Invalid directory")
    c = _ensure_browser(name)
    try:
        result = c.exec_run(["mkdir", "-p", safe])
    except APIError as exc:
        raise HTTPException(status_code=502, detail=str(exc))
    if result.exit_code != 0:
        raise HTTPException(
            status_code=400,
            detail=(result.output or b"").decode("utf-8", errors="replace") or "mkdir failed",
        )
    return {"created": safe[len("/target"):] or "/"}


@router.delete("/{name}/browse/file")
def delete_file(
    name: str,
    path: str = Query(...),
    _: User = Depends(require_admin),
) -> dict:
    safe = _safe_path(path)
    if safe == "/target":
        raise HTTPException(status_code=400, detail="Refusing to delete root")
    c = _ensure_browser(name)
    try:
        result = c.exec_run(["rm", "-rf", safe])
    except APIError as exc:
        raise HTTPException(status_code=502, detail=str(exc))
    if result.exit_code != 0:
        raise HTTPException(
            status_code=400,
            detail=(result.output or b"").decode("utf-8", errors="replace") or "rm failed",
        )
    return {"removed": safe[len("/target"):]}


@router.post("/{name}/browse/stop")
def stop_browser(name: str, _: User = Depends(require_admin)) -> dict:
    client = get_client()
    bname = _browser_name(name)
    try:
        c = client.containers.get(bname)
        c.remove(force=True)
        return {"stopped": True}
    except NotFound:
        return {"stopped": False, "reason": "not running"}
    except APIError as exc:
        raise HTTPException(status_code=502, detail=str(exc))

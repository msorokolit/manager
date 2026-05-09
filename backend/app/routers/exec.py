"""Interactive container exec over WebSocket.

Browsers cannot send custom Authorization headers when opening a WebSocket,
so authentication uses a short-lived (60s) one-shot ticket: the SPA calls
``POST /api/exec/ticket`` over HTTP Basic, then connects with
``?ticket=...``. Tickets are bound to the issuing role; only admins can use
exec because it's effectively shell access on the host.
"""
from __future__ import annotations

import asyncio
import json
import secrets
import threading
import time
from dataclasses import dataclass

from docker.errors import APIError, NotFound
from fastapi import APIRouter, Depends, HTTPException, Query, WebSocket, WebSocketDisconnect

from ..auth import User, authenticate
from ..config import settings
from ..docker_client import get_client

router = APIRouter(tags=["exec"])

_TICKET_TTL = 60.0


@dataclass
class _Ticket:
    user: str
    role: str
    expires_at: float


_TICKETS: dict[str, _Ticket] = {}
_TICKETS_LOCK = threading.Lock()


def _gc_tickets() -> None:
    now = time.time()
    with _TICKETS_LOCK:
        for k in [k for k, v in _TICKETS.items() if v.expires_at < now]:
            _TICKETS.pop(k, None)


@router.post("/api/exec/ticket")
def issue_ticket(user: User = Depends(authenticate)) -> dict:
    if user.role != "admin":
        raise HTTPException(status_code=403, detail="Exec requires admin role")
    _gc_tickets()
    token = secrets.token_urlsafe(24)
    with _TICKETS_LOCK:
        _TICKETS[token] = _Ticket(
            user=user.username, role=user.role, expires_at=time.time() + _TICKET_TTL
        )
    return {"ticket": token, "expires_in": int(_TICKET_TTL)}


def _consume_ticket(token: str) -> _Ticket | None:
    _gc_tickets()
    with _TICKETS_LOCK:
        rec = _TICKETS.pop(token, None)
    if not rec or rec.expires_at < time.time():
        return None
    return rec


def _raw_socket(sock_obj):
    """docker-py returns slightly different objects for the exec socket
    depending on the transport; normalise to something with read/write."""
    return getattr(sock_obj, "_sock", sock_obj)


@router.websocket("/api/containers/{container_id}/exec")
async def exec_terminal(
    websocket: WebSocket,
    container_id: str,
    ticket: str = Query(""),
    cmd: str = Query(""),
    cols: int = Query(80),
    rows: int = Query(24),
) -> None:
    rec = _consume_ticket(ticket)
    if rec is None:
        await websocket.close(code=4401)
        return
    if rec.role != "admin":
        await websocket.close(code=4403)
        return

    shell_cmd = cmd or settings.exec_default_shell
    try:
        client = get_client()
    except HTTPException:
        await websocket.close(code=4503)
        return

    try:
        container = client.containers.get(container_id)
    except NotFound:
        await websocket.close(code=4404)
        return
    except APIError:
        await websocket.close(code=4500)
        return

    try:
        api = client.api
        exec_id = api.exec_create(
            container.id,
            cmd=["sh", "-c", shell_cmd] if " " in shell_cmd else shell_cmd,
            stdin=True,
            stdout=True,
            stderr=True,
            tty=True,
        )["Id"]
        sock_obj = api.exec_start(
            exec_id, detach=False, tty=True, stream=False, socket=True
        )
        try:
            api.exec_resize(exec_id, height=max(1, rows), width=max(1, cols))
        except APIError:
            pass
    except APIError as exc:
        await websocket.close(code=4500, reason=str(exc)[:120])
        return

    raw = _raw_socket(sock_obj)
    await websocket.accept()

    loop = asyncio.get_event_loop()
    closed = asyncio.Event()

    def reader_thread() -> None:
        try:
            while not closed.is_set():
                try:
                    data = raw.recv(4096)
                except OSError:
                    break
                if not data:
                    break
                fut = asyncio.run_coroutine_threadsafe(
                    websocket.send_bytes(data), loop
                )
                try:
                    fut.result(timeout=5)
                except Exception:
                    break
        finally:
            asyncio.run_coroutine_threadsafe(_signal_close(), loop)

    async def _signal_close() -> None:
        closed.set()

    t = threading.Thread(target=reader_thread, daemon=True)
    t.start()

    try:
        while not closed.is_set():
            msg = await websocket.receive()
            if msg.get("type") == "websocket.disconnect":
                break
            if msg.get("bytes") is not None:
                try:
                    raw.sendall(msg["bytes"])
                except OSError:
                    break
            elif msg.get("text") is not None:
                txt = msg["text"]
                if txt.startswith("{"):
                    try:
                        obj = json.loads(txt)
                        if obj.get("type") == "resize":
                            try:
                                api.exec_resize(
                                    exec_id,
                                    height=int(obj.get("rows", 24)),
                                    width=int(obj.get("cols", 80)),
                                )
                            except APIError:
                                pass
                            continue
                    except Exception:
                        pass
                try:
                    raw.sendall(txt.encode())
                except OSError:
                    break
    except WebSocketDisconnect:
        pass
    finally:
        closed.set()
        try:
            raw.shutdown(2)
        except Exception:
            pass
        try:
            raw.close()
        except Exception:
            pass
        try:
            await websocket.close()
        except Exception:
            pass

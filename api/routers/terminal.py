import asyncio
import json
import logging
import select

from fastapi import APIRouter, WebSocket, WebSocketDisconnect

from api.services import runtime as containers, activity
from api.services.auth import MASTER_COOKIE, origin_is_trusted, verify_token

log = logging.getLogger(__name__)
router = APIRouter(tags=["terminal"])


@router.websocket("/api/terminal")
async def terminal_websocket(ws: WebSocket):
    """WebSocket terminal: bridges xterm.js to a shell on the box."""
    # Authenticate BEFORE accepting the upgrade — this socket hands out a shell.
    # MASTER session cookie ONLY: the terminal page is same-origin with the
    # dashboard, so the HttpOnly host-only cookie rides the upgrade by itself.
    # No ?token= (URL-borne master tokens leak into logs/history) and never the
    # derived files credential (read-only by design). An empty token is allowed
    # only in localhost-trust mode (OWNER_TOKEN unset) — verify_token() still
    # rejects it whenever OWNER_TOKEN is set.
    # CSRF layer: a browser always sends Origin on a WS upgrade. Refuse any origin
    # that is not a dashboard host — a content-sandboxed report is `Origin: null`,
    # so it cannot open this shell even though it shares the APP_DOMAIN site.
    if not origin_is_trusted(ws.headers.get("origin")):
        log.warning("Terminal WS refused: cross-origin %s", ws.headers.get("origin"))
        await ws.accept()
        await ws.close(code=4403, reason="Cross-origin refused")
        return

    token = ws.cookies.get(MASTER_COOKIE) or ""

    try:
        payload = verify_token(token)
    except Exception as e:
        log.error("Terminal WS token verification failed: %s", e)
        # A close-handshake needs an accepted socket; accept solely to send the
        # auth-failure close code — no shell resources exist yet at this point.
        await ws.accept()
        await ws.close(code=4001, reason="Invalid token")
        return

    await ws.accept()

    user_id = payload.get("sub")
    if not user_id:
        await ws.close(code=4001, reason="Invalid token: missing subject")
        return

    # Ensure container is running
    status = await containers.get_status(user_id)
    if status["status"] != "running":
        await ws.close(code=4002, reason="Computer not running")
        return

    # Create exec instance
    try:
        exec_id, container = await containers.exec_create(user_id)
    except Exception as e:
        log.error("Failed to create exec: %s", e)
        await ws.close(code=4003, reason="Failed to start terminal")
        return

    activity.connection_opened(user_id)

    # Start exec and get the raw socket
    sock = containers.exec_start(exec_id)
    raw_sock = sock._sock  # underlying socket from docker-py

    # Keep socket BLOCKING — we'll read in a thread
    raw_sock.setblocking(True)
    raw_sock.settimeout(0.5)  # timeout for clean shutdown
    loop = asyncio.get_event_loop()
    closed = asyncio.Event()

    async def read_from_container():
        """Read output from container and send to browser."""
        try:
            while not closed.is_set():

                def blocking_read():
                    try:
                        return raw_sock.recv(4096)
                    except TimeoutError:
                        return None
                    except OSError:
                        return b""

                data = await loop.run_in_executor(None, blocking_read)
                if data is None:
                    continue  # timeout, check closed flag
                if not data:
                    break  # connection closed
                await ws.send_bytes(data)
        except (OSError, WebSocketDisconnect):
            pass
        finally:
            closed.set()

    async def write_to_container():
        """Read input from browser and send to container."""
        try:
            while not closed.is_set():
                msg = await ws.receive()
                if msg["type"] == "websocket.receive":
                    if "bytes" in msg and msg["bytes"]:
                        raw_sock.sendall(msg["bytes"])
                    elif "text" in msg and msg["text"]:
                        # Handle resize commands
                        try:
                            data = json.loads(msg["text"])
                            if data.get("type") == "resize":
                                containers.exec_resize(
                                    exec_id,
                                    height=data["rows"],
                                    width=data["cols"],
                                )
                                continue
                        except (json.JSONDecodeError, KeyError):
                            pass
                        raw_sock.sendall(msg["text"].encode())
                elif msg["type"] == "websocket.disconnect":
                    break
        except (OSError, WebSocketDisconnect):
            pass
        finally:
            closed.set()

    # Run both directions concurrently
    reader = asyncio.create_task(read_from_container())
    writer = asyncio.create_task(write_to_container())

    try:
        done, pending = await asyncio.wait(
            [reader, writer], return_when=asyncio.FIRST_COMPLETED
        )
        for task in pending:
            task.cancel()
    finally:
        closed.set()
        raw_sock.close()
        activity.connection_closed(user_id)
        try:
            await ws.close()
        except Exception:
            pass

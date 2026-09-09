import asyncio
import json
import logging

from fastapi import APIRouter, WebSocket, WebSocketDisconnect

from api.services import runtime, activity
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

    status = await runtime.get_status(user_id)
    if status["status"] != "running":
        await ws.close(code=4002, reason="Computer not running")
        return

    try:
        shell = await runtime.open_shell(user_id)
    except Exception as e:
        log.error("Failed to open terminal shell: %s", e)
        await ws.close(code=4003, reason="Failed to start terminal")
        return

    activity.connection_opened(user_id)

    async def shell_to_browser():
        try:
            while True:
                data = await shell.read()
                if not data:
                    break  # shell exited
                await ws.send_bytes(data)
        except (OSError, WebSocketDisconnect, RuntimeError):
            pass

    async def browser_to_shell():
        try:
            while True:
                msg = await ws.receive()
                if msg["type"] == "websocket.disconnect":
                    break
                if msg["type"] != "websocket.receive":
                    continue
                if msg.get("bytes"):
                    shell.write(msg["bytes"])
                elif msg.get("text"):
                    text = msg["text"]
                    try:
                        data = json.loads(text)
                        if data.get("type") == "resize":
                            shell.resize(rows=data["rows"], cols=data["cols"])
                            continue
                    except (json.JSONDecodeError, KeyError, AttributeError):
                        pass
                    shell.write(text.encode())
        except (OSError, WebSocketDisconnect, RuntimeError):
            pass

    reader = asyncio.create_task(shell_to_browser())
    writer = asyncio.create_task(browser_to_shell())

    try:
        _done, pending = await asyncio.wait(
            [reader, writer], return_when=asyncio.FIRST_COMPLETED
        )
        for task in pending:
            task.cancel()
    finally:
        shell.close()
        activity.connection_closed(user_id)
        try:
            await ws.close()
        except Exception:
            pass

"""Real-time transcription WebSocket endpoints for WhisperLive."""
from __future__ import annotations

import asyncio
import json
import os
import struct
import uuid
from typing import Any

from fastapi import APIRouter, Request, WebSocket, WebSocketDisconnect

from .core._config import logger

router = APIRouter()


@router.get("/transcribe/ws-base")
async def transcribe_ws_base(request: Request) -> dict[str, str]:
    """Return backend WebSocket base URL, including the actual backend port."""
    server = request.scope.get("server")
    port = server[1] if server and len(server) > 1 else None
    scheme = "wss" if request.url.scheme == "https" else "ws"
    host = request.url.hostname or "localhost"
    if host in {"localhost", "127.0.0.1", "::1"}:
        host = "127.0.0.1"
    if isinstance(port, int):
        return {"ws_base": f"{scheme}://{host}:{port}"}
    return {"ws_base": f"{scheme}://{host}"}

# --- WhisperLive proxy (browser <-> FastAPI <-> WhisperLive server on 9090) ---

WHISPERLIVE_HOST = "127.0.0.1"
WHISPERLIVE_PORT = 9090


def _tail_whisperlive_log(log_path: str | None, max_chars: int = 1600) -> str:
    if not log_path:
        return ""
    if not os.path.exists(log_path):
        return ""
    try:
        with open(log_path, "r", encoding="utf-8", errors="replace") as fh:
            data = fh.read()
        return data[-max_chars:].strip()
    except OSError:
        return ""


def _pcm_int16_to_float32(data: bytes) -> bytes:
    """Convert PCM 16-bit LE to float32 LE (WhisperLive expects float32)."""
    n = len(data) // 2
    fmt = "<%dh" % n
    samples = struct.unpack(fmt, data)
    max_val = 32768.0
    floats = [s / max_val for s in samples]
    return struct.pack("<%df" % len(floats), *floats)


@router.websocket("/transcribe/whisperlive")
async def websocket_whisperlive_proxy(websocket: WebSocket) -> None:
    """Proxy browser WebSocket to WhisperLive server: send config then binary PCM (converted to float32)."""
    await websocket.accept()
    process = getattr(websocket.app.state, "whisperlive_process", None)
    log_path = getattr(websocket.app.state, "whisperlive_log_path", None)
    process_exited = process is not None and process.poll() is not None
    if process_exited and process is not None:
        code = process.returncode
        log_tail = _tail_whisperlive_log(log_path)
        detail = f" Last logs: {log_tail}" if log_tail else ""
        websocket.app.state.whisperlive_error = f"WhisperLive subprocess is not running (exit code {code}).{detail}"
        websocket.app.state.whisperlive_available = False

    if not getattr(websocket.app.state, "whisperlive_available", False):
        details = getattr(websocket.app.state, "whisperlive_error", None)
        await websocket.send_text(
            json.dumps({
                "error": (
                    f"WhisperLive is not available. {details}"
                    if details
                    else "WhisperLive is not available."
                )
            })
        )
        await websocket.close()
        return
    import websockets

    try:
        async with websockets.connect(
            f"ws://{WHISPERLIVE_HOST}:{WHISPERLIVE_PORT}"
        ) as ws_server:
            # Send WhisperLive config (same as WhisperLive client)
            config: dict[str, Any] = {
                "uid": str(uuid.uuid4()),
                "language": "en",
                "task": "transcribe",
                "model": "tiny",
                "use_vad": True,
                "send_last_n_segments": 10,
                "no_speech_thresh": 0.45,
                "clip_audio": False,
                "same_output_threshold": 10,
                "enable_translation": False,
                "target_language": "en",
            }
            await ws_server.send(json.dumps(config))
            server_ready = asyncio.Event()

            async def forward_from_browser() -> None:
                try:
                    # WhisperLive sends SERVER_READY after model/client init.
                    await asyncio.wait_for(server_ready.wait(), timeout=20)
                    while True:
                        raw = await websocket.receive_bytes()
                        # Browser sends PCM 16-bit; WhisperLive expects float32
                        float_buf = _pcm_int16_to_float32(raw)
                        await ws_server.send(float_buf)
                except WebSocketDisconnect:
                    logger.info("WhisperLive proxy: browser disconnected")
                except TimeoutError:
                    await websocket.send_text(json.dumps({"error": "WhisperLive backend did not become ready in time."}))
                except Exception as e:
                    logger.warning("WhisperLive proxy browser->server error: %s", e)
                    try:
                        await websocket.send_text(json.dumps({"error": "Transcription stream error"}))
                    except Exception:
                        pass

            async def forward_from_server() -> None:
                try:
                    async for message in ws_server:
                        if isinstance(message, str):
                            try:
                                payload = json.loads(message)
                                if payload.get("message") == "SERVER_READY":
                                    server_ready.set()
                                if payload.get("status") == "ERROR" and payload.get("message"):
                                    await websocket.send_text(json.dumps({"error": payload["message"]}))
                                    continue
                            except json.JSONDecodeError:
                                pass
                            await websocket.send_text(message)
                        else:
                            await websocket.send_bytes(message)
                except Exception as e:
                    logger.warning("WhisperLive proxy server->browser error: %s", e)
                    try:
                        await websocket.send_text(json.dumps({"error": "Transcription service disconnected"}))
                    except Exception:
                        pass

            tasks = {
                asyncio.create_task(forward_from_browser()),
                asyncio.create_task(forward_from_server()),
            }
            done, pending = await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)
            for task in pending:
                task.cancel()
            for task in (*done, *pending):
                try:
                    await task
                except asyncio.CancelledError:
                    pass
                except Exception as e:
                    logger.warning("WhisperLive proxy task failed: %s", e)
    except (ConnectionRefusedError, OSError):
        process = getattr(websocket.app.state, "whisperlive_process", None)
        details = None
        if process is not None and process.poll() is not None:
            log_tail = _tail_whisperlive_log(log_path)
            tail_part = f" Last logs: {log_tail}" if log_tail else ""
            details = f"WhisperLive subprocess exited (code {process.returncode}).{tail_part}"
            websocket.app.state.whisperlive_available = False
            websocket.app.state.whisperlive_error = details
        await websocket.send_text(
            json.dumps({
                "error": (
                    f"WhisperLive server is not running. {details}"
                    if details
                    else "WhisperLive server is not running on 127.0.0.1:9090."
                )
            })
        )
    except Exception as e:
        logger.exception("WhisperLive proxy unexpected error")
        await websocket.send_text(json.dumps({"error": "Transcription service error"}))
    finally:
        try:
            await websocket.close()
        except Exception:
            pass

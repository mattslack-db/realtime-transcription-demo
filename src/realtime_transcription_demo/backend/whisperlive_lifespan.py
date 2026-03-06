"""Lifespan dependency that starts WhisperLive server in a subprocess for WebSocket proxy."""
from __future__ import annotations

import asyncio
import os
import subprocess
import sys
import tempfile
from contextlib import asynccontextmanager
from typing import AsyncGenerator

from fastapi import FastAPI, Request

from .core._base import LifespanDependency
from .core._config import logger


class _WhisperLiveServerDependency(LifespanDependency):
    """Starts WhisperLive server on 127.0.0.1:9090 for the proxy endpoint."""

    @staticmethod
    async def _wait_for_port(host: str, port: int, timeout_s: float = 8.0) -> bool:
        deadline = asyncio.get_event_loop().time() + timeout_s
        while asyncio.get_event_loop().time() < deadline:
            try:
                _, writer = await asyncio.wait_for(
                    asyncio.open_connection(host, port), timeout=0.5
                )
                writer.close()
                await writer.wait_closed()
                return True
            except OSError:
                await asyncio.sleep(0.1)
        return False

    @staticmethod
    def _tail_log(path: str, max_chars: int = 2000) -> str:
        try:
            with open(path, "r", encoding="utf-8", errors="replace") as fh:
                data = fh.read()
            return data[-max_chars:].strip()
        except OSError:
            return ""

    @asynccontextmanager
    async def lifespan(self, app: FastAPI) -> AsyncGenerator[None, None]:
        process = None
        log_fp = None
        log_path = os.path.join(tempfile.gettempdir(), "whisperlive-subprocess.log")
        app.state.whisperlive_error = None
        app.state.whisperlive_log_path = log_path
        try:
            try:
                import whisper_live  # noqa: F401
            except ImportError:
                logger.info(
                    "whisper-live not installed; WhisperLive transcription page will show unavailable."
                )
                app.state.whisperlive_process = None
                app.state.whisperlive_available = False
                app.state.whisperlive_error = "whisper-live is not installed in this environment."
                yield
                return
            # Start WhisperLive server as subprocess (faster_whisper, small model, CPU-friendly)
            cmd = [
                sys.executable,
                "-c",
                (
                    "from whisper_live.server import TranscriptionServer; "
                    "s = TranscriptionServer(); "
                    "s.run('127.0.0.1', 9090, backend='faster_whisper')"
                ),
            ]
            env = os.environ.copy()
            env.setdefault("OMP_NUM_THREADS", "1")
            log_fp = open(log_path, "a", encoding="utf-8")
            process = subprocess.Popen(
                cmd,
                env=env,
                stdout=log_fp,
                stderr=log_fp,
            )
            ready = await self._wait_for_port("127.0.0.1", 9090, timeout_s=8.0)
            if process.poll() is not None:
                code = process.returncode
                log_tail = self._tail_log(log_path)
                detail = f" Last logs: {log_tail}" if log_tail else ""
                app.state.whisperlive_process = process
                app.state.whisperlive_available = False
                app.state.whisperlive_error = f"WhisperLive subprocess exited during startup (code {code}).{detail}"
                logger.warning(app.state.whisperlive_error)
            elif not ready:
                log_tail = self._tail_log(log_path)
                detail = f" Last logs: {log_tail}" if log_tail else ""
                app.state.whisperlive_process = process
                app.state.whisperlive_available = False
                app.state.whisperlive_error = f"WhisperLive subprocess did not open port 9090 in time.{detail}"
                logger.warning(app.state.whisperlive_error)
            else:
                app.state.whisperlive_process = process
                app.state.whisperlive_available = True
                app.state.whisperlive_error = None
                logger.info("WhisperLive server subprocess started on 127.0.0.1:9090")
            yield
        finally:
            if log_fp is not None:
                log_fp.close()
            if process is not None:
                process.terminate()
                try:
                    process.wait(timeout=10)
                except subprocess.TimeoutExpired:
                    process.kill()
                logger.info("WhisperLive server subprocess stopped")
            app.state.whisperlive_process = None
            app.state.whisperlive_available = False
            app.state.whisperlive_error = None

    @staticmethod
    def __call__(request: Request) -> None:
        return None

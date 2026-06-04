import json
import logging
import threading
from collections.abc import Callable
from contextlib import suppress
from dataclasses import dataclass, field
from typing import Any

from websockets.exceptions import ConnectionClosed
from websockets.sync.connection import Connection
from websockets.sync.server import serve

from .cli_output import announce

logger = logging.getLogger(__name__)


@dataclass
class _ClientSession:
    connection: Connection
    _latest_message: str | None = None
    _wake_event: threading.Event = field(default_factory=threading.Event)
    _lock: threading.Lock = field(default_factory=threading.Lock)
    _closed: bool = False

    def offer(self, message: str) -> None:
        with self._lock:
            if self._closed:
                return
            self._latest_message = message
            self._wake_event.set()

    def close(self) -> None:
        with self._lock:
            self._closed = True
            self._wake_event.set()

    def sender_loop(self) -> None:
        while True:
            self._wake_event.wait()
            while True:
                with self._lock:
                    if self._closed:
                        return
                    message = self._latest_message
                    self._latest_message = None
                    if message is None:
                        self._wake_event.clear()
                        break
                try:
                    self.connection.send(message)
                except ConnectionClosed:
                    return


class WebSocketBroadcaster:
    def __init__(
        self,
        port: int,
        *,
        path: str,
        banner: str,
        host: str = "localhost",
        client_count_callback: Callable[[int], None] | None = None,
    ) -> None:
        self._port = port
        self._host = host
        self._path = path
        self._banner = banner
        self._client_count_callback = client_count_callback
        self._clients: dict[Connection, _ClientSession] = {}
        self._clients_lock = threading.Lock()

        thread = threading.Thread(target=self._run_server, daemon=True)
        thread.start()

    def _run_server(self) -> None:
        serve(self._handler, host=self._host, port=self._port).serve_forever()

    def _report_client_count(self, count: int) -> None:
        if self._client_count_callback is not None:
            self._client_count_callback(count)

    def _handler(self, ws: Connection) -> None:
        if ws.request is None or ws.request.path != self._path:
            ws.close(code=1008, reason="Invalid path")
            return

        try:
            ws.send(self._banner)
            session = _ClientSession(connection=ws)
            sender_thread = threading.Thread(
                target=session.sender_loop, daemon=True
            )
            with self._clients_lock:
                self._clients[ws] = session
                connection_count = len(self._clients)
            self._report_client_count(connection_count)
            announce(
                f"WebSocket client connected ({connection_count} active)",
                logger,
            )
            sender_thread.start()
            while True:
                with suppress(TimeoutError):
                    ws.recv(timeout=60)  # Keep alive by blocking
        except ConnectionClosed:
            pass
        finally:
            removed_session: _ClientSession | None
            with self._clients_lock:
                removed_session = self._clients.pop(ws, None)
                connection_count = len(self._clients)
            if removed_session is not None:
                removed_session.close()
            self._report_client_count(connection_count)
            announce(
                f"WebSocket client disconnected ({connection_count} active)",
                logger,
            )

    def send_state(self, state: dict[Any, Any]) -> None:
        message = json.dumps(state)
        with self._clients_lock:
            sessions = list(self._clients.values())
        for session in sessions:
            session.offer(message)

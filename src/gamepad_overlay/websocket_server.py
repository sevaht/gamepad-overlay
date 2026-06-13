import http
import json
import logging
import mimetypes
import threading
from collections.abc import Callable
from contextlib import suppress
from dataclasses import dataclass, field
from importlib import resources
from pathlib import PurePosixPath
from typing import Any, Protocol
from urllib.parse import urlsplit

from websockets.datastructures import Headers
from websockets.exceptions import ConnectionClosed
from websockets.http11 import Request, Response
from websockets.sync.connection import Connection
from websockets.sync.server import serve

from .cli_output import announce

logger = logging.getLogger(__name__)


class _OverlayRoot(Protocol):
    def joinpath(self, *_pathsegments: str) -> "_OverlayRoot": ...

    def is_file(self) -> bool: ...

    def read_bytes(self) -> bytes: ...


def _overlay_roots() -> list[_OverlayRoot]:
    roots: list[_OverlayRoot] = []

    packaged_root = resources.files("gamepad_overlay").joinpath(
        "overlay_assets"
    )
    if packaged_root.joinpath("index.html").is_file():
        roots.append(packaged_root)

    return roots


def _overlay_asset_path(request_path: str) -> PurePosixPath | None:
    path = urlsplit(request_path).path or "/"
    if path == "/":
        return PurePosixPath("index.html")

    relative_path = path.lstrip("/")
    if path.endswith("/"):
        relative_path += "index.html"

    asset_path = PurePosixPath(relative_path)
    if asset_path.is_absolute() or ".." in asset_path.parts:
        return None

    return asset_path


def _content_type_for_asset(asset_path: PurePosixPath) -> str:
    content_type, _encoding = mimetypes.guess_type(str(asset_path))
    if content_type is None:
        return "application/octet-stream"

    if content_type.startswith("text/") or content_type in {
        "application/javascript",
        "application/json",
        "image/svg+xml",
    }:
        return f"{content_type}; charset=utf-8"

    return content_type


def _http_response(
    status: http.HTTPStatus, body: bytes, *, content_type: str
) -> Response:
    headers = Headers()
    headers["Content-Type"] = content_type
    headers["Content-Length"] = str(len(body))
    return Response(status.value, status.phrase, headers, body)


def _serve_overlay_asset(request_path: str) -> Response:
    asset_path = _overlay_asset_path(request_path)
    if asset_path is None:
        return _http_response(
            http.HTTPStatus.NOT_FOUND,
            b"Not found\n",
            content_type="text/plain; charset=utf-8",
        )

    for root in _overlay_roots():
        candidate = root.joinpath(*asset_path.parts)
        if candidate.is_file():
            return _http_response(
                http.HTTPStatus.OK,
                candidate.read_bytes(),
                content_type=_content_type_for_asset(asset_path),
            )

    return _http_response(
        http.HTTPStatus.NOT_FOUND,
        b"Not found\n",
        content_type="text/plain; charset=utf-8",
    )


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
        serve(
            self._handler,
            host=self._host,
            port=self._port,
            process_request=self._process_request,
        ).serve_forever()

    def _report_client_count(self, count: int) -> None:
        if self._client_count_callback is not None:
            self._client_count_callback(count)

    def _process_request(
        self, _connection: Connection, request: Request
    ) -> Response | None:
        request_path = urlsplit(request.path).path
        if request_path == self._path:
            return None
        if request_path == "/healthz":
            return _http_response(
                http.HTTPStatus.OK,
                b"OK\n",
                content_type="text/plain; charset=utf-8",
            )
        return _serve_overlay_asset(request.path)

    def _handler(self, ws: Connection) -> None:
        if ws.request is None or urlsplit(ws.request.path).path != self._path:
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

from __future__ import annotations

import logging
import signal
from dataclasses import dataclass, field
from threading import Event, Lock, Thread
from typing import TYPE_CHECKING, Any

from .application import (
    DEFAULT_PORT,
    GamepadInfo,
    ServerRunConfig,
    _selection_config_path,
    run_server,
)
from .gamepad_selector import (
    GamepadSelectorConfig,
    GamepadSelectorWindow,
    _status_text,
)
from .tray_backend import create_tray_icon
from .tray_render import _tray_icon_renderer

logger = logging.getLogger(__name__)

if TYPE_CHECKING:
    from collections.abc import Callable
    from pathlib import Path

    from .tray_backend import TrayIcon


@dataclass
class ManagedServerBackend:
    config_path: Path
    port: int = DEFAULT_PORT
    lan: bool = False
    terminal: bool = False
    device_change_callback: Callable[[], None] | None = None
    active_gamepad_callback: Callable[[GamepadInfo | None], None] | None = None
    client_count_callback: Callable[[int], None] | None = None
    thread: Thread | None = field(default=None, init=False)
    stop_event: Event = field(default_factory=Event, init=False)
    failed: bool = field(default=False, init=False)
    active_gamepad_info: GamepadInfo | None = field(default=None, init=False)
    connected_client_count: int = field(default=0, init=False)

    def ensure_started(self) -> None:
        if self.thread is not None and self.thread.is_alive():
            return
        self.failed = False
        self.stop_event.clear()
        self.thread = Thread(
            target=self._run_server, name="gamepad-overlay", daemon=True
        )
        self.thread.start()

    def _run_server(self) -> None:
        try:
            run_server(
                ServerRunConfig(
                    config_path=self.config_path,
                    port=self.port,
                    lan=self.lan,
                    terminal=self.terminal,
                    stop_event=self.stop_event,
                    device_change_callback=self.device_change_callback,
                    active_gamepad_callback=self.active_gamepad_callback,
                    client_count_callback=self.client_count_callback,
                )
            )
        except Exception:
            # Top-level guard for the background server thread: surface any
            # failure via the status label instead of dying silently.
            self.failed = True
            logger.exception("Managed gamepad server stopped unexpectedly")

    def status_label(self) -> str:
        if self.thread is not None and self.thread.is_alive():
            return "Server: running"
        if self.failed:
            return "Server: stopped unexpectedly"
        return "Server: stopped"

    def is_gamepad_connected(self) -> bool:
        return self.active_gamepad_info is not None

    def client_count(self) -> int:
        return self.connected_client_count

    def active_gamepad(self) -> GamepadInfo | None:
        return self.active_gamepad_info

    def stop(self) -> None:
        self.stop_event.set()
        if self.thread is not None:
            self.thread.join(timeout=0.2)
        self.active_gamepad_info = None
        self.connected_client_count = 0


class GamepadSelectorTray:
    def __init__(
        self,
        config_path: Path | None = None,
        *,
        port: int = DEFAULT_PORT,
        lan: bool = False,
        terminal: bool = False,
    ) -> None:
        self.config_path = config_path or _selection_config_path()
        self.server_backend = ManagedServerBackend(
            config_path=self.config_path,
            port=port,
            lan=lan,
            terminal=terminal,
            device_change_callback=self._refresh_from_backend,
            active_gamepad_callback=self._handle_active_gamepad_changed,
            client_count_callback=self._handle_client_count_changed,
        )
        self.server_backend.ensure_started()
        self.window = GamepadSelectorWindow(
            self.config_path,
            GamepadSelectorConfig(
                hide_on_close=True,
                quit_callback=self._request_quit,
                selection_changed_callback=self._sync_connection_state,
                overlay_port=self.server_backend.port,
            ),
            server_backend=self.server_backend,
        )
        self._tray_lock = Lock()
        self._tray_icon_connected: bool | None = None
        self._tray_title = _status_text(attached=False, client_count=0)
        self._start_hidden = False
        self.icon: TrayIcon = create_tray_icon(
            "gamepad-overlay",
            self._tray_title,
            _tray_icon_renderer(False),
            on_activate=self.window.show,
            on_quit=self._request_quit,
        )
        self._sync_connection_state()

    def _apply_tray_state(self) -> None:
        with self._tray_lock:
            connected = self.server_backend.is_gamepad_connected()
            title = _status_text(
                attached=connected,
                client_count=self.server_backend.client_count(),
            )
            self.icon.title = title
            if connected != self._tray_icon_connected:
                self.icon.set_icon(_tray_icon_renderer(connected))
                self._tray_icon_connected = connected
            self._tray_title = title

    def _refresh_from_backend(self) -> None:
        self.window.refresh()
        self._sync_connection_state()

    def _handle_active_gamepad_changed(
        self, active_gamepad: GamepadInfo | None
    ) -> None:
        self.server_backend.active_gamepad_info = active_gamepad
        self.window.refresh()
        self._sync_connection_state()

    def _handle_client_count_changed(self, client_count: int) -> None:
        self.server_backend.connected_client_count = client_count
        self._sync_connection_state()

    def _sync_connection_state(self) -> None:
        self.window._update_connection_state()
        self._apply_tray_state()

    def _request_quit(self) -> None:
        def _do_quit() -> None:
            if not self.window.confirm_quit():
                return
            self._quit()

        self.window._invoke_ui(_do_quit)

    def _quit(self) -> None:
        self.window.close()
        self.server_backend.stop()
        self.icon.stop()

    def _setup(self, _icon: object) -> None:
        self.icon.visible = True
        self._apply_tray_state()
        if not self._start_hidden:
            self.window.show()

    def run(self, *, start_hidden: bool = False) -> int:
        self._start_hidden = start_hidden
        self.icon.run(setup=self._setup)
        return 0


def _install_signal_handlers(
    quit_callback: Callable[[], None],
) -> list[tuple[int, Any]]:
    handlers: list[tuple[int, Any]] = []

    def handle_signal(_signum: int, _frame: object | None) -> None:
        quit_callback()

    handlers.append(
        (signal.SIGINT, signal.signal(signal.SIGINT, handle_signal))
    )
    if hasattr(signal, "SIGTERM"):
        handlers.append(
            (signal.SIGTERM, signal.signal(signal.SIGTERM, handle_signal))
        )
    return handlers


def _restore_signal_handlers(handlers: list[tuple[int, Any]]) -> None:
    for signum, previous_handler in handlers:
        signal.signal(signum, previous_handler)


def run_tray(
    *,
    config_path: Path | None = None,
    port: int = DEFAULT_PORT,
    lan: bool = False,
    terminal: bool = False,
    start_hidden: bool = False,
) -> int:
    tray = GamepadSelectorTray(
        config_path, port=port, lan=lan, terminal=terminal
    )
    handlers = _install_signal_handlers(tray._quit)
    try:
        return tray.run(start_hidden=start_hidden)
    finally:
        _restore_signal_handlers(handlers)

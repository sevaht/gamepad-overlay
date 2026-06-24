from __future__ import annotations

import logging
from dataclasses import dataclass, field
from threading import Event, Lock, Thread
from typing import TYPE_CHECKING

from sevaht_gui import TkApp

from . import user_config_path
from .config import CONFIG_FILE_NAME
from .gamepad_selector import (
    GamepadSelectorConfig,
    GamepadSelectorWindow,
    _status_tooltip,
)
from .server import DEFAULT_PORT, ServerRunConfig, load_server_port, run_server
from .tray_render import _tray_icon_renderer

logger = logging.getLogger(__name__)

if TYPE_CHECKING:
    from collections.abc import Callable
    from pathlib import Path

    from sevaht_gui import TrayIcon

    from .gamepad import GamepadInfo


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
    active_gamepad_info: GamepadInfo | None = field(default=None, init=False)
    connected_client_count: int = field(default=0, init=False)

    def ensure_started(self) -> None:
        if self.thread is not None and self.thread.is_alive():
            return
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
            # Top-level guard for the background server thread: log any failure
            # instead of dying silently.
            logger.exception("Managed gamepad server stopped unexpectedly")

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

    def restart(self, new_port: int) -> None:
        self.stop()
        if self.thread is not None:
            self.thread.join(timeout=2.0)
        self.port = new_port
        self.thread = None
        self.ensure_started()


class GamepadSelectorTray:
    def __init__(
        self,
        config_path: Path | None = None,
        *,
        lan: bool = False,
        terminal: bool = False,
    ) -> None:
        self.config_path = config_path or user_config_path() / CONFIG_FILE_NAME
        self.server_backend = ManagedServerBackend(
            config_path=self.config_path,
            port=load_server_port(self.config_path),
            lan=lan,
            terminal=terminal,
            device_change_callback=self._refresh_from_backend,
            active_gamepad_callback=self._handle_active_gamepad_changed,
            client_count_callback=self._handle_client_count_changed,
        )
        self._tray_lock = Lock()
        self._tray_icon_connected: bool | None = None
        self._tray_title = _status_tooltip(attached=False, client_count=0)
        self._start_hidden = False
        # Option A: tk owns the main thread; the tray icon (if any) runs on a
        # worker thread via app.run. The app handles theme, the window-close
        # behavior, and the quit confirmation.
        self.app = TkApp(
            quit_confirm="Quit the tray and stop the managed gamepad server?"
        )
        # Create the tray first so the window knows whether one exists (it
        # adapts its close button accordingly). None => no system tray, and the
        # app runs window-only.
        # on_activate resolves self.window lazily (it is created just below).
        self.tray_icon: TrayIcon | None = self.app.create_tray_icon(
            "gamepad-overlay",
            self._tray_title,
            _tray_icon_renderer(False),
            on_activate=self._show_window,
            activate_label="Configure...",
        )
        self.window = GamepadSelectorWindow(
            self.app,
            self.config_path,
            GamepadSelectorConfig(
                hide_on_close=self.app.has_tray,
                selection_changed_callback=self._sync_connection_state,
            ),
            server_backend=self.server_backend,
        )
        self._sync_connection_state()
        # Start the managed server last: its callbacks touch self.tray_icon and
        # self.window, so both must exist before the server thread can fire.
        self.server_backend.ensure_started()

    def _apply_tray_state(self) -> None:
        if self.tray_icon is None:
            # No system tray; the window still reflects status (title/icon) via
            # update_connection_state, so there is nothing to update here.
            return
        with self._tray_lock:
            connected = self.server_backend.is_gamepad_connected()
            title = _status_tooltip(
                attached=connected,
                client_count=self.server_backend.client_count(),
            )
            self.tray_icon.title = title
            if connected != self._tray_icon_connected:
                self.tray_icon.set_icon(_tray_icon_renderer(connected))
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
        self.window.update_connection_state()
        self._apply_tray_state()

    def _show_window(self) -> None:
        self.window.show()

    def _on_tray_ready(self) -> None:
        # Runs on the tray's own thread once its event loop is live (passed to
        # app.run as tray_setup).
        with self._tray_lock:
            # pystray on Windows can't update the HICON before the event loop
            # starts, so any set_icon calls made before it is running are
            # silently lost. Reset the cached state here so _apply_tray_state
            # always calls set_icon once the loop is live and NIM_MODIFY takes
            # effect.
            self._tray_icon_connected = None
        self._apply_tray_state()
        if not self._start_hidden:
            self.window.show()

    def run(self, *, start_hidden: bool = False) -> int:
        self._start_hidden = start_hidden
        if self.tray_icon is None:
            # No system tray: the window is the only UI, so it must be visible.
            self.window.show()
            self.app.run()
        else:
            self.app.run(self.tray_icon, tray_setup=self._on_tray_ready)
        # The UI loop has exited; stop the managed server.
        self.server_backend.stop()
        return 0


def run_tray(
    *,
    config_path: Path | None = None,
    lan: bool = False,
    terminal: bool = False,
    start_hidden: bool = False,
) -> int:
    tray = GamepadSelectorTray(config_path, lan=lan, terminal=terminal)
    return tray.run(start_hidden=start_hidden)

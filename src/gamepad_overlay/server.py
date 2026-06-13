from __future__ import annotations

import logging
from dataclasses import dataclass, field
from typing import TYPE_CHECKING

from .cli_output import announce
from .config import read_section, update_section
from .gamepad import (
    GamepadInfo,
    GamepadMonitor,
    GamepadSelection,
    Input,
    SDLGamepad,
)
from .websocket_server import WebSocketBroadcaster

if TYPE_CHECKING:
    from collections.abc import Callable
    from pathlib import Path
    from threading import Event

DEFAULT_PORT = 8765
MIN_PORT = 1025
MAX_PORT = 65535

SERVER_SECTION = "server"

logger = logging.getLogger(__name__)


def load_server_port(path: Path) -> int:
    port = read_section(path, SERVER_SECTION).get("port")
    if isinstance(port, int) and MIN_PORT <= port <= MAX_PORT:
        return port
    return DEFAULT_PORT


def save_server_port(port: int, path: Path) -> None:
    server_section = read_section(path, SERVER_SECTION)
    server_section["port"] = port
    update_section(path, SERVER_SECTION, server_section)


@dataclass
class ServerRunConfig:
    config_path: Path
    port: int = DEFAULT_PORT
    lan: bool = False
    terminal: bool = False
    stop_event: Event | None = None
    device_change_callback: Callable[[], None] | None = None
    active_gamepad_callback: Callable[[GamepadInfo | None], None] | None = None
    client_count_callback: Callable[[int], None] | None = None


@dataclass
class _GamepadStateMonitor:
    state: dict[str, float] = field(default_factory=dict)

    def on_start(self, _gamepad: SDLGamepad, inputs: list[Input]) -> None:
        logger.info(f"START: initializing {len(inputs)} inputs.")
        self.state = {
            gamepad_input.identifier.user.name: 0.0
            for gamepad_input in inputs
            if gamepad_input.identifier.user
        }
        self.broadcast()

    def on_sync(self, _gamepad: SDLGamepad) -> None:
        self.broadcast()

    def on_update(
        self, _gamepad: SDLGamepad, gamepad_input: Input, value: int
    ) -> None:
        if gamepad_input.identifier.user:
            name = gamepad_input.identifier.user.name
            logger.debug(f"Update: {name} = {value}")
            self.state[name] = gamepad_input.range.as_percentage(value)
        else:
            internal = gamepad_input.identifier.internal
            logger.warning(f"UNHANDLED: {internal} = {value}")

    def broadcast(self) -> None:
        raise NotImplementedError

    def __repr__(self) -> str:
        return " ".join(
            f"{name}={value}" for name, value in self.state.items()
        )


@dataclass
class TerminalGamepadMonitor(_GamepadStateMonitor):
    def broadcast(self) -> None:
        print(f"STATE: {self}")


@dataclass
class WebSocketGamepadMonitor(_GamepadStateMonitor):
    websocket_broadcaster: WebSocketBroadcaster = field(kw_only=True)

    def broadcast(self) -> None:
        self.websocket_broadcaster.send_state(self.state)


def run_server(config: ServerRunConfig) -> int:
    saved_selection = GamepadSelection.load(config.config_path)

    if config.terminal:
        monitor: GamepadMonitor = TerminalGamepadMonitor()
    else:
        bind_host = "0.0.0.0" if config.lan else "localhost"  # noqa: S104
        websocket_broadcaster = WebSocketBroadcaster(
            config.port,
            host=bind_host,
            path="/gamepad-overlay",
            banner="gamepad-overlay",
            client_count_callback=config.client_count_callback,
        )
        monitor = WebSocketGamepadMonitor(
            websocket_broadcaster=websocket_broadcaster
        )

    gamepad = SDLGamepad(selected_gamepad=saved_selection)
    try:
        gamepad.read_loop(
            monitor,
            selection_path=config.config_path,
            stop_event=config.stop_event,
            device_change_callback=config.device_change_callback,
            active_gamepad_callback=config.active_gamepad_callback,
        )
    except KeyboardInterrupt:
        announce("\nExiting.", logger)
    finally:
        gamepad.close()
    return 0

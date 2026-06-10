from __future__ import annotations

import argparse
import ctypes
import importlib.metadata
import json
import logging
import os
import platform
from contextlib import suppress
from dataclasses import dataclass, field
from enum import IntEnum, auto, unique
from pathlib import Path
from typing import TYPE_CHECKING, Any, Protocol

import sdl3
from sevaht_utility.log_utility import add_log_arguments, configure_logging

from .cli_output import announce
from .websocket_server import WebSocketBroadcaster

if TYPE_CHECKING:
    from collections.abc import Callable, Mapping, Sequence
    from threading import Event

GAMEPAD_SELECTION_FIELDS = ("guid", "vendor", "product", "port")

logger = logging.getLogger(__name__)

SELECTION_CONFIG_FILE_NAME = "gamepad-selection.json"
DEFAULT_PORT = 8765


@dataclass(frozen=True)
class InputRange:
    minimum: int
    maximum: int

    def clamp(self, value: int) -> int:
        if value < self.minimum:
            return self.minimum
        if value > self.maximum:
            return self.maximum
        return value

    def as_percentage(self, value: int) -> float:
        if value < 0:
            return value / abs(self.minimum)
        return value / self.maximum


@dataclass(kw_only=True, frozen=True)
class Identifier:
    user: GamepadInput | None
    internal: str


@dataclass(kw_only=True, frozen=True)
class Input:
    identifier: Identifier
    range: InputRange


class GamepadMonitor(Protocol):
    def on_start(self, gamepad: SDLGamepad, inputs: list[Input]) -> None: ...

    def on_sync(self, gamepad: SDLGamepad) -> None: ...

    def on_update(
        self, gamepad: SDLGamepad, gamepad_input: Input, value: int
    ) -> None: ...


@unique
class GamepadInput(IntEnum):
    A = auto()
    B = auto()
    X = auto()
    Y = auto()
    SELECT = auto()
    START = auto()
    GUIDE = auto()
    LB = auto()
    RB = auto()
    LS = auto()
    RS = auto()
    LX = auto()
    LY = auto()
    RX = auto()
    RY = auto()
    LT = auto()
    RT = auto()
    DX = auto()
    DY = auto()


BUTTON_RANGE = InputRange(minimum=0, maximum=1)
STICK_RANGE = InputRange(minimum=-32768, maximum=32767)
TRIGGER_RANGE = InputRange(minimum=0, maximum=32767)
DPAD_RANGE = InputRange(minimum=-1, maximum=1)


SDL_BUTTON_MAP: dict[int, tuple[str, GamepadInput]] = {
    sdl3.SDL_GAMEPAD_BUTTON_SOUTH: (
        "SDL_GAMEPAD_BUTTON_SOUTH",
        GamepadInput.A,
    ),
    sdl3.SDL_GAMEPAD_BUTTON_EAST: ("SDL_GAMEPAD_BUTTON_EAST", GamepadInput.B),
    sdl3.SDL_GAMEPAD_BUTTON_WEST: ("SDL_GAMEPAD_BUTTON_WEST", GamepadInput.X),
    sdl3.SDL_GAMEPAD_BUTTON_NORTH: (
        "SDL_GAMEPAD_BUTTON_NORTH",
        GamepadInput.Y,
    ),
    sdl3.SDL_GAMEPAD_BUTTON_BACK: (
        "SDL_GAMEPAD_BUTTON_BACK",
        GamepadInput.SELECT,
    ),
    sdl3.SDL_GAMEPAD_BUTTON_START: (
        "SDL_GAMEPAD_BUTTON_START",
        GamepadInput.START,
    ),
    sdl3.SDL_GAMEPAD_BUTTON_GUIDE: (
        "SDL_GAMEPAD_BUTTON_GUIDE",
        GamepadInput.GUIDE,
    ),
    sdl3.SDL_GAMEPAD_BUTTON_LEFT_SHOULDER: (
        "SDL_GAMEPAD_BUTTON_LEFT_SHOULDER",
        GamepadInput.LB,
    ),
    sdl3.SDL_GAMEPAD_BUTTON_RIGHT_SHOULDER: (
        "SDL_GAMEPAD_BUTTON_RIGHT_SHOULDER",
        GamepadInput.RB,
    ),
    sdl3.SDL_GAMEPAD_BUTTON_LEFT_STICK: (
        "SDL_GAMEPAD_BUTTON_LEFT_STICK",
        GamepadInput.LS,
    ),
    sdl3.SDL_GAMEPAD_BUTTON_RIGHT_STICK: (
        "SDL_GAMEPAD_BUTTON_RIGHT_STICK",
        GamepadInput.RS,
    ),
}

SDL_AXIS_MAP: dict[int, tuple[str, GamepadInput, InputRange]] = {
    sdl3.SDL_GAMEPAD_AXIS_LEFTX: (
        "SDL_GAMEPAD_AXIS_LEFTX",
        GamepadInput.LX,
        STICK_RANGE,
    ),
    sdl3.SDL_GAMEPAD_AXIS_LEFTY: (
        "SDL_GAMEPAD_AXIS_LEFTY",
        GamepadInput.LY,
        STICK_RANGE,
    ),
    sdl3.SDL_GAMEPAD_AXIS_RIGHTX: (
        "SDL_GAMEPAD_AXIS_RIGHTX",
        GamepadInput.RX,
        STICK_RANGE,
    ),
    sdl3.SDL_GAMEPAD_AXIS_RIGHTY: (
        "SDL_GAMEPAD_AXIS_RIGHTY",
        GamepadInput.RY,
        STICK_RANGE,
    ),
    sdl3.SDL_GAMEPAD_AXIS_LEFT_TRIGGER: (
        "SDL_GAMEPAD_AXIS_LEFT_TRIGGER",
        GamepadInput.LT,
        TRIGGER_RANGE,
    ),
    sdl3.SDL_GAMEPAD_AXIS_RIGHT_TRIGGER: (
        "SDL_GAMEPAD_AXIS_RIGHT_TRIGGER",
        GamepadInput.RT,
        TRIGGER_RANGE,
    ),
}


def _build_inputs() -> dict[GamepadInput, Input]:
    inputs: dict[GamepadInput, Input] = {}
    for internal, mapped in SDL_BUTTON_MAP.values():
        inputs[mapped] = Input(
            identifier=Identifier(user=mapped, internal=internal),
            range=BUTTON_RANGE,
        )

    for internal, mapped, input_range in SDL_AXIS_MAP.values():
        inputs[mapped] = Input(
            identifier=Identifier(user=mapped, internal=internal),
            range=input_range,
        )

    inputs[GamepadInput.DX] = Input(
        identifier=Identifier(user=GamepadInput.DX, internal="SDL_DPAD_X"),
        range=DPAD_RANGE,
    )
    inputs[GamepadInput.DY] = Input(
        identifier=Identifier(user=GamepadInput.DY, internal="SDL_DPAD_Y"),
        range=DPAD_RANGE,
    )
    return inputs


@dataclass
class SDLGamepad:
    selected_guid: str | None = None
    selected_gamepad: dict[str, str] | None = None
    _gamepad: Any = field(default=None, init=False)
    _gamepad_id: int | None = field(default=None, init=False)
    inputs: dict[GamepadInput, Input] = field(
        default_factory=_build_inputs, init=False
    )
    _dpad_left: bool = field(default=False, init=False)
    _dpad_right: bool = field(default=False, init=False)
    _dpad_up: bool = field(default=False, init=False)
    _dpad_down: bool = field(default=False, init=False)
    _selection_mtime_ns: int | None = field(default=None, init=False)
    _active_gamepad_info: dict[str, object] | None = field(
        default=None, init=False
    )

    def __post_init__(self) -> None:
        if not sdl3.SDL_Init(sdl3.SDL_INIT_GAMEPAD):
            error = sdl3.SDL_GetError().decode("utf-8")
            message = f"SDL_Init failed: {error}"
            raise RuntimeError(message)

        sdl3.SDL_SetGamepadEventsEnabled(True)

    def _target_description(self) -> str:
        if self.selected_gamepad is not None:
            return _selection_target_description(self.selected_gamepad)
        if self.selected_guid:
            return f"guid={self.selected_guid}"
        return "any gamepad"

    @staticmethod
    def _device_guid(gamepad_id: int) -> str:
        guid = sdl3.SDL_GetGamepadGUIDForID(gamepad_id)
        buffer = ctypes.create_string_buffer(33)
        sdl3.SDL_GUIDToString(guid, buffer, len(buffer))
        return buffer.value.decode("utf-8")

    @staticmethod
    def _decode_sdl_string(value: object) -> str:
        if value is None:
            return ""
        if isinstance(value, bytes):
            return value.decode("utf-8", errors="replace")
        return str(value)

    @staticmethod
    def _device_string(gamepad_id: int, function_name: str) -> str:
        function = getattr(sdl3, function_name, None)
        if not callable(function):
            return ""
        return SDLGamepad._decode_sdl_string(function(gamepad_id))

    @staticmethod
    def _device_integer(gamepad_id: int, function_name: str) -> str:
        function = getattr(sdl3, function_name, None)
        if not callable(function):
            return ""
        value = int(function(gamepad_id))
        return "" if value <= 0 else str(value)

    @staticmethod
    def _enumerate_gamepad_ids() -> list[int]:
        count = ctypes.c_int()
        gamepad_ids = sdl3.SDL_GetGamepads(ctypes.byref(count))
        try:
            return [int(gamepad_ids[index]) for index in range(count.value)]
        finally:
            if gamepad_ids:
                sdl3.SDL_free(gamepad_ids)

    @staticmethod
    def _gamepad_info(gamepad_id: int) -> dict[str, object]:
        name_ptr = sdl3.SDL_GetGamepadNameForID(gamepad_id)
        name = "unknown" if name_ptr is None else name_ptr.decode("utf-8")
        sdl_path = SDLGamepad._device_string(
            gamepad_id, "SDL_GetGamepadPathForID"
        )
        return {
            "index": gamepad_id,
            "name": name,
            "guid": SDLGamepad._device_guid(gamepad_id),
            "path": sdl_path,
            "port": _get_device_port_path(sdl_path),
            "vendor": SDLGamepad._device_integer(
                gamepad_id, "SDL_GetGamepadVendorForID"
            ),
            "product": SDLGamepad._device_integer(
                gamepad_id, "SDL_GetGamepadProductForID"
            ),
            "product_version": SDLGamepad._device_integer(
                gamepad_id, "SDL_GetGamepadProductVersionForID"
            ),
        }

    @staticmethod
    def _matches_selected_gamepad(
        gamepad: dict[str, object], selected: dict[str, str] | None
    ) -> bool:
        if selected is None:
            return True

        matched_field = False
        for field_name in GAMEPAD_SELECTION_FIELDS:
            selected_value = selected.get(field_name, "")
            if not selected_value:
                continue
            matched_field = True
            gamepad_value = str(gamepad.get(field_name, "")).strip()
            if not gamepad_value:
                return False
            if selected_value.lower() != gamepad_value.lower():
                return False
        return matched_field

    @staticmethod
    def list_available_gamepads() -> list[dict[str, object]]:
        initialized_here = False
        if sdl3.SDL_WasInit(sdl3.SDL_INIT_GAMEPAD) == 0:
            if not sdl3.SDL_Init(sdl3.SDL_INIT_GAMEPAD):
                error = sdl3.SDL_GetError().decode("utf-8")
                message = f"SDL_Init failed: {error}"
                raise RuntimeError(message)
            initialized_here = True
        try:
            return [
                SDLGamepad._gamepad_info(gamepad_id)
                for gamepad_id in SDLGamepad._enumerate_gamepad_ids()
            ]
        finally:
            if initialized_here:
                sdl3.SDL_QuitSubSystem(sdl3.SDL_INIT_GAMEPAD)

    def _try_open_gamepad(self) -> bool:
        for gamepad_id in self._enumerate_gamepad_ids():
            gamepad_info = self._gamepad_info(gamepad_id)
            guid = str(gamepad_info.get("guid", ""))
            name = str(gamepad_info.get("name", "unknown"))

            if (
                self.selected_guid
                and guid.lower() != self.selected_guid.lower()
            ):
                continue
            if (
                self.selected_gamepad is not None
                and not self._matches_selected_gamepad(
                    gamepad_info, self.selected_gamepad
                )
            ):
                continue

            gamepad = sdl3.SDL_OpenGamepad(gamepad_id)
            if not gamepad:
                logger.warning(
                    "Failed to open SDL gamepad id %s: %s",
                    gamepad_id,
                    sdl3.SDL_GetError().decode("utf-8"),
                )
                continue

            self._gamepad = gamepad
            self._gamepad_id = int(sdl3.SDL_GetGamepadID(gamepad))
            self._active_gamepad_info = gamepad_info
            metadata = _gamepad_metadata_summary(gamepad_info)
            suffix = f" {metadata}" if metadata else ""
            announce(f"Connected to gamepad: {name}{suffix}", logger)
            return True
        return False

    def _selection_signature(self) -> tuple[str | None, tuple[str, ...]]:
        selection_values: tuple[str, ...] = ()
        if self.selected_gamepad is not None:
            selection_values = tuple(
                self.selected_gamepad.get(field_name, "")
                for field_name in GAMEPAD_SELECTION_FIELDS
            )
        return (self.selected_guid, selection_values)

    def _apply_selection(
        self, selected: dict[str, str] | None, *, announce_change: bool
    ) -> None:
        guid = selected.get("guid") if selected else None
        normalized_guid = guid or None
        old_signature = self._selection_signature()
        self.selected_guid = normalized_guid
        self.selected_gamepad = selected
        if self._selection_signature() == old_signature:
            return
        if announce_change:
            announce(
                f"Gamepad target changed to: {self._target_description()}",
                logger,
            )
        if self._gamepad is not None:
            sdl3.SDL_CloseGamepad(self._gamepad)
            self._gamepad = None
            self._gamepad_id = None
            self._active_gamepad_info = None

    def reload_selection_from_config(self, path: Path) -> None:
        try:
            stat = path.stat()
            mtime_ns: int | None = stat.st_mtime_ns
        except FileNotFoundError:
            mtime_ns = None
        if mtime_ns == self._selection_mtime_ns:
            return
        self._selection_mtime_ns = mtime_ns
        selected = _load_selected_gamepad(path)
        self._apply_selection(selected, announce_change=True)

    def _wait_for_gamepad(
        self,
        monitor: GamepadMonitor,
        *,
        announced_waiting: bool,
        report_connection_state: Callable[[], None],
    ) -> bool:
        if self._gamepad is not None:
            return announced_waiting
        if self._try_open_gamepad():
            report_connection_state()
            monitor.on_start(self, list(self.inputs.values()))
            if announced_waiting:
                announce(
                    f"Gamepad reattached: {self._target_description()}", logger
                )
            return False
        if not announced_waiting:
            announce(
                "Detached, waiting for gamepad attachment: "
                f"{self._target_description()}",
                logger,
            )
        report_connection_state()
        return True

    def _handle_read_loop_event(
        self,
        event: sdl3.SDL_Event,
        monitor: GamepadMonitor,
        *,
        device_change_callback: Callable[[], None] | None,
        report_connection_state: Callable[[], None],
    ) -> None:
        if (
            event.type
            in (sdl3.SDL_EVENT_GAMEPAD_ADDED, sdl3.SDL_EVENT_GAMEPAD_REMOVED)
            and device_change_callback is not None
        ):
            device_change_callback()

        updated = self._handle_event(event, monitor)
        report_connection_state()
        if updated:
            monitor.on_sync(self)

    def close(self) -> None:
        if self._gamepad:
            sdl3.SDL_CloseGamepad(self._gamepad)
            self._gamepad = None
            self._gamepad_id = None
            self._active_gamepad_info = None
        sdl3.SDL_QuitSubSystem(sdl3.SDL_INIT_GAMEPAD)

    def read_loop(
        self,
        monitor: GamepadMonitor,
        *,
        selection_path: Path | None = None,
        stop_event: Event | None = None,
        device_change_callback: Callable[[], None] | None = None,
        active_gamepad_callback: (
            Callable[[dict[str, object] | None], None] | None
        ) = None,
    ) -> None:
        event = sdl3.SDL_Event()
        announced_waiting = False
        reported_active_gamepad: dict[str, object] | None = None

        def report_active_gamepad() -> None:
            nonlocal reported_active_gamepad
            active_gamepad = self._active_gamepad_info
            if active_gamepad == reported_active_gamepad:
                return
            reported_active_gamepad = active_gamepad
            if active_gamepad_callback is not None:
                active_gamepad_callback(active_gamepad)

        announce(f"Gamepad target: {self._target_description()}", logger)
        try:
            while stop_event is None or not stop_event.is_set():
                if selection_path is not None:
                    self.reload_selection_from_config(selection_path)
                    report_active_gamepad()
                announced_waiting = self._wait_for_gamepad(
                    monitor,
                    announced_waiting=announced_waiting,
                    report_connection_state=report_active_gamepad,
                )

                if not sdl3.SDL_WaitEventTimeout(event, 2000):
                    continue

                self._handle_read_loop_event(
                    event,
                    monitor,
                    device_change_callback=device_change_callback,
                    report_connection_state=report_active_gamepad,
                )
        finally:
            if reported_active_gamepad is not None:
                reported_active_gamepad = None
                if active_gamepad_callback is not None:
                    active_gamepad_callback(None)

    def _handle_event(
        self, event: sdl3.SDL_Event, monitor: GamepadMonitor
    ) -> bool:
        if event.type == sdl3.SDL_EVENT_GAMEPAD_AXIS_MOTION:
            return self._handle_axis_event(event, monitor)

        if event.type in (
            sdl3.SDL_EVENT_GAMEPAD_BUTTON_DOWN,
            sdl3.SDL_EVENT_GAMEPAD_BUTTON_UP,
        ):
            return self._handle_button_event(event, monitor)

        if (
            event.type == sdl3.SDL_EVENT_GAMEPAD_REMOVED
            and self._gamepad_id is not None
            and int(event.gdevice.which) == self._gamepad_id
        ):
            announce(
                "Gamepad detached, waiting for reattachment: "
                f"{self._target_description()}",
                logger,
                level=logging.WARNING,
            )
            if self._gamepad is not None:
                sdl3.SDL_CloseGamepad(self._gamepad)
            self._gamepad = None
            self._gamepad_id = None
            self._active_gamepad_info = None
            return False

        if event.type == sdl3.SDL_EVENT_GAMEPAD_ADDED:
            return False

        return False

    def _handle_axis_event(
        self, event: sdl3.SDL_Event, monitor: GamepadMonitor
    ) -> bool:
        if int(event.gaxis.which) != self._gamepad_id:
            return False
        mapped = SDL_AXIS_MAP.get(int(event.gaxis.axis))
        if mapped is None:
            return False

        _, target, input_range = mapped
        gamepad_input = self.inputs[target]
        value = input_range.clamp(int(event.gaxis.value))
        monitor.on_update(self, gamepad_input, value)
        return True

    def _handle_button_event(
        self, event: sdl3.SDL_Event, monitor: GamepadMonitor
    ) -> bool:
        if int(event.gbutton.which) != self._gamepad_id:
            return False

        button = int(event.gbutton.button)
        value = 1 if event.gbutton.down else 0

        dpad_handlers: dict[int, tuple[str, bool]] = {
            sdl3.SDL_GAMEPAD_BUTTON_DPAD_LEFT: ("_dpad_left", True),
            sdl3.SDL_GAMEPAD_BUTTON_DPAD_RIGHT: ("_dpad_right", True),
            sdl3.SDL_GAMEPAD_BUTTON_DPAD_UP: ("_dpad_up", False),
            sdl3.SDL_GAMEPAD_BUTTON_DPAD_DOWN: ("_dpad_down", False),
        }
        dpad_handler = dpad_handlers.get(button)
        if dpad_handler is not None:
            attribute_name, is_x_axis = dpad_handler
            setattr(self, attribute_name, value == 1)
            if is_x_axis:
                return self._emit_dpad_x(monitor)
            return self._emit_dpad_y(monitor)

        button_mapping = SDL_BUTTON_MAP.get(button)
        if button_mapping is None:
            return False

        _, target = button_mapping
        gamepad_input = self.inputs[target]
        monitor.on_update(self, gamepad_input, value)
        return True

    def _emit_dpad_x(self, monitor: GamepadMonitor) -> bool:
        value = 0
        if self._dpad_left:
            value = -1
        elif self._dpad_right:
            value = 1
        monitor.on_update(self, self.inputs[GamepadInput.DX], value)
        return True

    def _emit_dpad_y(self, monitor: GamepadMonitor) -> bool:
        value = 0
        if self._dpad_up:
            value = -1
        elif self._dpad_down:
            value = 1
        monitor.on_update(self, self.inputs[GamepadInput.DY], value)
        return True


@dataclass
class ServerRunConfig:
    config_path: Path
    port: int = DEFAULT_PORT
    lan: bool = False
    terminal: bool = False
    stop_event: Event | None = None
    device_change_callback: Callable[[], None] | None = None
    active_gamepad_callback: (
        Callable[[dict[str, object] | None], None] | None
    ) = None
    client_count_callback: Callable[[int], None] | None = None


@dataclass
class TerminalGamepadMonitor:
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

    def broadcast(self) -> None:
        print(f"STATE: {self}")

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

    def __repr__(self) -> str:
        return " ".join(
            f"{name}={value}" for name, value in self.state.items()
        )


@dataclass
class WebSocketGamepadMonitor:
    websocket_broadcaster: WebSocketBroadcaster
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

    def broadcast(self) -> None:
        self.websocket_broadcaster.send_state(self.state)

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

    def __repr__(self) -> str:
        return " ".join(
            f"{name}={value}" for name, value in self.state.items()
        )


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="gamepad-overlay",
        description=importlib.metadata.metadata(__package__).get("summary"),
    )

    selection_group = parser.add_argument_group(
        "selection mode",
        "Save a gamepad selection and exit."
        " Cannot be combined with run mode arguments.",
    )
    selection_group.add_argument(
        "--list-gamepads",
        action="store_true",
        help="List connected gamepads and exit.",
    )
    selection_group.add_argument(
        "--any-gamepad",
        action="store_true",
        help="Clear the saved gamepad selection (use any gamepad) and exit.",
    )
    selection_group.add_argument(
        "--select-gamepad",
        action="store_true",
        help="Interactively select a connected gamepad, save it, and exit.",
    )
    gamepad_id_group = selection_group.add_mutually_exclusive_group()
    gamepad_id_group.add_argument(
        "--gamepad-guid",
        metavar="GUID",
        help="Save a gamepad selection by GUID and exit.",
    )
    gamepad_id_group.add_argument(
        "--gamepad-name",
        metavar="NAME",
        help="Save a gamepad selection by name substring (resolves to the"
        " matching controller's hardware identity) and exit.",
    )
    selection_group.add_argument(
        "--gamepad-port",
        metavar="PORT",
        help="Include connection path in the saved selection"
        " (combinable with --gamepad-guid or --gamepad-name).",
    )

    run_group = parser.add_argument_group(
        "run mode",
        "Start the server."
        " Cannot be combined with selection mode arguments.",
    )
    run_group.add_argument(
        "--headless",
        action="store_true",
        help="Run the server directly without the system tray.",
    )
    run_group.add_argument(
        "--hide",
        action="store_true",
        help="Start the system tray with the selector window hidden.",
    )
    output_group = run_group.add_mutually_exclusive_group()
    output_group.add_argument(
        "--lan",
        action="store_true",
        help="Allow websocket connections from other machines on the LAN.",
    )
    output_group.add_argument(
        "--terminal",
        action="store_true",
        help="Print gamepad state to the terminal instead of broadcasting"
        " via websocket.",
    )
    run_group.add_argument(
        "--port",
        type=int,
        default=DEFAULT_PORT,
        metavar="PORT",
        help=f"Websocket port to listen on (default: {DEFAULT_PORT}).",
    )

    add_log_arguments(parser)
    return parser


def _print_available_gamepads() -> int:
    gamepads = SDLGamepad.list_available_gamepads()
    if not gamepads:
        print("No compatible gamepads detected.")
        return 0
    for gamepad_info in gamepads:
        metadata = _gamepad_metadata_summary(gamepad_info)
        meta_str = f"  {metadata}" if metadata else ""
        print(f"[{gamepad_info['index']}] {gamepad_info['name']}{meta_str}")
    return 0


def _format_hex_identifier(value: object) -> str:
    text = str(value or "").strip()
    if not text:
        return ""
    try:
        return f"{int(text):04x}"
    except ValueError:
        return text


def _gamepad_vid_pid(gamepad: Mapping[str, object]) -> str:
    vendor = _format_hex_identifier(gamepad.get("vendor"))
    product = _format_hex_identifier(gamepad.get("product"))
    if vendor and product:
        return f"{vendor}:{product}"
    return ""


def _get_device_port_path(device_path: str) -> str:
    """Return a stable port identifier for a device node, cross-platform."""
    if not device_path:
        return ""
    if platform.system() == "Linux":
        by_path_dir = Path("/dev/input/by-path")
        if not by_path_dir.is_dir():
            return ""
        try:
            real_target = Path(device_path).resolve()
            for link in by_path_dir.iterdir():
                try:
                    if link.resolve() == real_target:
                        return link.name
                except OSError:
                    continue
        except OSError:
            pass
        return ""
    # Windows: HID path encodes USB location and is stable per port.
    # macOS/other: use SDL path as best-effort.
    return device_path


def _port_display_name(port: str) -> str:
    """Return a concise display form of a port path (strips PCI prefix on Linux)."""
    usb_idx = port.find("usb-")
    return port[usb_idx:] if usb_idx != -1 else port


def _selection_target_description(
    selected: Mapping[str, object] | None,
) -> str:
    if not selected or not any(str(v).strip() for v in selected.values()):
        return "any gamepad"
    has_identity = any(
        str(selected.get(f, "")).strip()
        for f in ("guid", "vendor", "product", "name")
    )
    port = str(selected.get("port", "")).strip()
    name = str(selected.get("name", "")).strip() or "unknown controller"
    vid_pid = _gamepad_vid_pid(selected)
    if vid_pid:
        name_str = f"{name} [{vid_pid}]"
    elif has_identity:
        guid = str(selected.get("guid", "")).strip()
        name_str = f"{name} [{guid}]" if guid else name
    else:
        name_str = name
    if has_identity and port:
        return f"{name_str} on {_port_display_name(port)}"
    if has_identity:
        return f"{name_str} (any port)"
    if port:
        return f"any controller on {_port_display_name(port)}"
    return "any gamepad"


def _gamepad_metadata_summary(gamepad: Mapping[str, object]) -> str:
    id_parts: list[str] = []
    vendor_product = _gamepad_vid_pid(gamepad)
    if vendor_product:
        id_parts.append(f"[{vendor_product}]")
    else:
        guid = str(gamepad.get("guid", "")).strip()
        if guid:
            id_parts.append(f"[{guid}]")
    port = str(gamepad.get("port", "")).strip()
    if port:
        usb_idx = port.find("usb-")
        port_display = port[usb_idx:] if usb_idx != -1 else port
        id_parts.append(f"[{port_display}]")
    return " ".join(id_parts)


def _select_and_save_gamepad(config_path: Path) -> int:
    selected = _interactive_select_gamepad()
    if selected is None:
        print("No gamepad selected.")
        return 1
    if not selected:
        _clear_selected_gamepad(config_path)
        print("Will use any gamepad.")
        return 0
    _save_selected_gamepad(config_path, selected)
    print(
        f"Saved gamepad selection: {_selection_target_description(selected)}"
    )
    return 0


def _save_gamepad_by_criteria(
    guid: str | None, name: str | None, port: str | None, config_path: Path
) -> int:
    selection: dict[str, str] = dict.fromkeys(GAMEPAD_SELECTION_FIELDS, "")
    if name:
        gamepads = SDLGamepad.list_available_gamepads()
        matches = [
            g
            for g in gamepads
            if name.lower() in str(g.get("name", "")).lower()
            and (not port or str(g.get("port", "")) == port)
        ]
        if not matches:
            desc = repr(name) + (f" on port {port!r}" if port else "")
            print(f"No connected gamepad matches {desc}.")
            return 1
        found = matches[0]
        selection["guid"] = str(found.get("guid", ""))
        selection["vendor"] = str(found.get("vendor", ""))
        selection["product"] = str(found.get("product", ""))
        selection["name"] = str(found.get("name", ""))
        if port:
            selection["port"] = port
    elif guid:
        selection["guid"] = guid
        if port:
            selection["port"] = port
        gamepads = SDLGamepad.list_available_gamepads()
        for g in gamepads:
            if str(g.get("guid", "")).lower() == guid.lower():
                selection["vendor"] = str(g.get("vendor", ""))
                selection["product"] = str(g.get("product", ""))
                selection["name"] = str(g.get("name", ""))
                break
    else:
        selection["port"] = port or ""
    _save_selected_gamepad(config_path, selection)
    print(
        f"Saved gamepad selection: {_selection_target_description(selection)}"
    )
    return 0


def _run_tray(args: argparse.Namespace, config_path: Path) -> int:
    from .tray import run_tray

    return run_tray(
        config_path=config_path,
        port=args.port,
        lan=args.lan,
        terminal=args.terminal,
        start_hidden=args.hide,
    )


def run_server(config: ServerRunConfig) -> int:
    selected_config = _load_selected_gamepad(config.config_path)

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

    gamepad = SDLGamepad(
        selected_guid=(
            selected_config.get("guid") if selected_config else None
        )
        or None,
        selected_gamepad=selected_config,
    )
    selection_watch_path = config.config_path
    try:
        gamepad.read_loop(
            monitor,
            selection_path=selection_watch_path,
            stop_event=config.stop_event,
            device_change_callback=config.device_change_callback,
            active_gamepad_callback=config.active_gamepad_callback,
        )
    except KeyboardInterrupt:
        announce("\nExiting.", logger)
    finally:
        gamepad.close()
    return 0


def _run_headless_server(args: argparse.Namespace, config_path: Path) -> int:
    return run_server(
        ServerRunConfig(
            config_path=config_path,
            port=args.port,
            lan=args.lan,
            terminal=args.terminal,
        )
    )


def main(argv: Sequence[str] | None = None) -> int:  # noqa: C901, PLR0912
    parser = _build_parser()
    args = parser.parse_args(args=argv)
    configure_logging(args)

    config_path = _selection_config_path()

    # Detect which mode is active
    selection_args: list[str] = []
    if args.list_gamepads:
        selection_args.append("--list-gamepads")
    if args.any_gamepad:
        selection_args.append("--any-gamepad")
    if args.select_gamepad:
        selection_args.append("--select-gamepad")
    has_criteria = bool(
        args.gamepad_guid or args.gamepad_name or args.gamepad_port
    )
    if has_criteria:
        selection_args.append("--gamepad-guid/name/port")

    run_args: list[str] = []
    if args.headless:
        run_args.append("--headless")
    if args.hide:
        run_args.append("--hide")
    if args.lan:
        run_args.append("--lan")
    if args.terminal:
        run_args.append("--terminal")
    if args.port != DEFAULT_PORT:
        run_args.append("--port")

    if len(selection_args) > 1:
        parser.error(
            f"these arguments cannot be combined: {', '.join(selection_args)}"
        )
    if selection_args and run_args:
        parser.error(
            f"selection arguments ({', '.join(selection_args)}) cannot be"
            f" combined with run arguments ({', '.join(run_args)})"
        )

    # Selection mode: save a selection and exit
    if args.list_gamepads:
        return _print_available_gamepads()

    if args.any_gamepad:
        _clear_selected_gamepad(config_path)
        print("Will use any gamepad.")
        return 0

    if args.select_gamepad:
        return _select_and_save_gamepad(config_path)

    if has_criteria:
        return _save_gamepad_by_criteria(
            guid=args.gamepad_guid,
            name=args.gamepad_name,
            port=args.gamepad_port,
            config_path=config_path,
        )

    # Run mode
    if not args.headless:
        return _run_tray(args, config_path)

    return _run_headless_server(args, config_path)


def _selection_config_path() -> Path:
    config_home = os.environ.get("XDG_CONFIG_HOME")
    base = Path(config_home) if config_home else Path.home() / ".config"
    return base / "gamepad-overlay" / SELECTION_CONFIG_FILE_NAME


def _load_selected_gamepad(path: Path) -> dict[str, str] | None:
    if not path.exists():
        return None
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        logger.warning("Failed to read gamepad selection config at %s", path)
        return None
    result = {
        field_name: str(payload.get(field_name, "")).strip()
        for field_name in (*GAMEPAD_SELECTION_FIELDS, "name")
    }
    if not any(result[f] for f in GAMEPAD_SELECTION_FIELDS):
        return None
    return result


def _save_selected_gamepad(path: Path, selected: Mapping[str, object]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    data = {
        field_name: str(selected.get(field_name, "")).strip()
        for field_name in (*GAMEPAD_SELECTION_FIELDS, "name")
    }
    path.write_text(json.dumps(data, indent=2) + "\n", encoding="utf-8")


def _clear_selected_gamepad(path: Path) -> None:
    with suppress(FileNotFoundError):
        path.unlink()


def _interactive_select_gamepad() -> (  # noqa: C901, PLR0912
    dict[str, object] | None
):
    gamepads = SDLGamepad.list_available_gamepads()
    if not gamepads:
        print("No compatible gamepads detected.")
        return None
    print("Detected gamepads:")
    for idx, gamepad in enumerate(gamepads, start=1):
        metadata = _gamepad_metadata_summary(gamepad)
        meta_str = f"  {metadata}" if metadata else ""
        print(f"  {idx}) {gamepad['name']}{meta_str}")
    print("  0) (any gamepad)")
    print()
    while True:
        try:
            choice = input(
                "Select gamepad number (0 for any, or blank to cancel): "
            ).strip()
        except KeyboardInterrupt:
            print()
            return None
        if choice == "":
            return None
        if not choice.isdigit():
            print("Invalid selection. Enter a number.")
            continue
        selected_index = int(choice)
        if selected_index == 0:
            return {}  # signal "use any"
        if 1 <= selected_index <= len(gamepads):
            selected = dict(gamepads[selected_index - 1])
            port = str(selected.get("port", "")).strip()
            if port:
                port_display = _port_display_name(port)
                print("  Match by:")
                print("    1) Controller identity only (any port)")
                print(f"    2) USB port only ({port_display})")
                print("    3) Both identity and USB port")
                while True:
                    try:
                        criteria = input("  Choose [1]: ").strip()
                    except KeyboardInterrupt:
                        print()
                        return None
                    if criteria in ("", "1"):
                        selected["port"] = ""
                        break
                    if criteria == "2":
                        for field in ("guid", "vendor", "product"):
                            selected[field] = ""
                        break
                    if criteria == "3":
                        break
                    print("  Enter 1, 2, or 3.")
            return selected
        print("Selection out of range.")

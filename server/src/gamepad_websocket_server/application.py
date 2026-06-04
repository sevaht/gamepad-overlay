from __future__ import annotations

import argparse
import ctypes
import importlib.metadata
import json
import logging
import os
from dataclasses import dataclass, field
from enum import IntEnum, auto, unique
from pathlib import Path
from typing import TYPE_CHECKING, Protocol

import sdl2
from sevaht_utility.log_utility import add_log_arguments, configure_logging

from .cli_output import announce
from .websocket_server import WebSocketBroadcaster

if TYPE_CHECKING:
    from collections.abc import Callable, Sequence
    from threading import Event

CONTROLLER_CONFIG_FIELDS = ("guid", "vendor", "product", "name")

logger = logging.getLogger(__name__)

CONFIG_FILE_NAME = "controller-selection.json"


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
    def on_start(
        self, controller: SDLGameController, inputs: list[Input]
    ) -> None: ...

    def on_sync(self, controller: SDLGameController) -> None: ...

    def on_update(
        self, controller: SDLGameController, gamepad_input: Input, value: int
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
    sdl2.SDL_CONTROLLER_BUTTON_A: ("SDL_CONTROLLER_BUTTON_A", GamepadInput.A),
    sdl2.SDL_CONTROLLER_BUTTON_B: ("SDL_CONTROLLER_BUTTON_B", GamepadInput.B),
    sdl2.SDL_CONTROLLER_BUTTON_X: ("SDL_CONTROLLER_BUTTON_X", GamepadInput.X),
    sdl2.SDL_CONTROLLER_BUTTON_Y: ("SDL_CONTROLLER_BUTTON_Y", GamepadInput.Y),
    sdl2.SDL_CONTROLLER_BUTTON_BACK: (
        "SDL_CONTROLLER_BUTTON_BACK",
        GamepadInput.SELECT,
    ),
    sdl2.SDL_CONTROLLER_BUTTON_START: (
        "SDL_CONTROLLER_BUTTON_START",
        GamepadInput.START,
    ),
    sdl2.SDL_CONTROLLER_BUTTON_GUIDE: (
        "SDL_CONTROLLER_BUTTON_GUIDE",
        GamepadInput.GUIDE,
    ),
    sdl2.SDL_CONTROLLER_BUTTON_LEFTSHOULDER: (
        "SDL_CONTROLLER_BUTTON_LEFTSHOULDER",
        GamepadInput.LB,
    ),
    sdl2.SDL_CONTROLLER_BUTTON_RIGHTSHOULDER: (
        "SDL_CONTROLLER_BUTTON_RIGHTSHOULDER",
        GamepadInput.RB,
    ),
    sdl2.SDL_CONTROLLER_BUTTON_LEFTSTICK: (
        "SDL_CONTROLLER_BUTTON_LEFTSTICK",
        GamepadInput.LS,
    ),
    sdl2.SDL_CONTROLLER_BUTTON_RIGHTSTICK: (
        "SDL_CONTROLLER_BUTTON_RIGHTSTICK",
        GamepadInput.RS,
    ),
}

SDL_AXIS_MAP: dict[int, tuple[str, GamepadInput, InputRange]] = {
    sdl2.SDL_CONTROLLER_AXIS_LEFTX: (
        "SDL_CONTROLLER_AXIS_LEFTX",
        GamepadInput.LX,
        STICK_RANGE,
    ),
    sdl2.SDL_CONTROLLER_AXIS_LEFTY: (
        "SDL_CONTROLLER_AXIS_LEFTY",
        GamepadInput.LY,
        STICK_RANGE,
    ),
    sdl2.SDL_CONTROLLER_AXIS_RIGHTX: (
        "SDL_CONTROLLER_AXIS_RIGHTX",
        GamepadInput.RX,
        STICK_RANGE,
    ),
    sdl2.SDL_CONTROLLER_AXIS_RIGHTY: (
        "SDL_CONTROLLER_AXIS_RIGHTY",
        GamepadInput.RY,
        STICK_RANGE,
    ),
    sdl2.SDL_CONTROLLER_AXIS_TRIGGERLEFT: (
        "SDL_CONTROLLER_AXIS_TRIGGERLEFT",
        GamepadInput.LT,
        TRIGGER_RANGE,
    ),
    sdl2.SDL_CONTROLLER_AXIS_TRIGGERRIGHT: (
        "SDL_CONTROLLER_AXIS_TRIGGERRIGHT",
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
class SDLGameController:
    selected_guid: str | None = None
    name_filter: str | None = None
    selected_controller: dict[str, str] | None = None
    _controller: sdl2.SDL_GameController | None = field(
        default=None, init=False
    )
    _instance_id: int | None = field(default=None, init=False)
    inputs: dict[GamepadInput, Input] = field(
        default_factory=_build_inputs, init=False
    )
    _dpad_left: bool = field(default=False, init=False)
    _dpad_right: bool = field(default=False, init=False)
    _dpad_up: bool = field(default=False, init=False)
    _dpad_down: bool = field(default=False, init=False)
    _selection_mtime_ns: int | None = field(default=None, init=False)
    _active_controller_info: dict[str, object] | None = field(
        default=None, init=False
    )

    def __post_init__(self) -> None:
        if sdl2.SDL_Init(sdl2.SDL_INIT_GAMECONTROLLER) != 0:
            error = sdl2.SDL_GetError().decode("utf-8")
            message = f"SDL_Init failed: {error}"
            raise RuntimeError(message)

        sdl2.SDL_GameControllerEventState(sdl2.SDL_ENABLE)

    def _target_description(self) -> str:
        if self.selected_guid:
            return f"guid={self.selected_guid}"
        if self.name_filter:
            return f"name~='{self.name_filter}'"
        return "any game controller"

    @staticmethod
    def _device_guid(joystick_index: int) -> str:
        guid = sdl2.SDL_JoystickGetDeviceGUID(joystick_index)
        buffer = ctypes.create_string_buffer(33)
        sdl2.SDL_JoystickGetGUIDString(guid, buffer, len(buffer))
        return buffer.value.decode("utf-8")

    @staticmethod
    def _decode_sdl_string(value: object) -> str:
        if value is None:
            return ""
        if isinstance(value, bytes):
            return value.decode("utf-8", errors="replace")
        return str(value)

    @staticmethod
    def _device_string(joystick_index: int, function_name: str) -> str:
        function = getattr(sdl2, function_name, None)
        if not callable(function):
            return ""
        return SDLGameController._decode_sdl_string(function(joystick_index))

    @staticmethod
    def _device_integer(joystick_index: int, function_name: str) -> str:
        function = getattr(sdl2, function_name, None)
        if not callable(function):
            return ""
        value = int(function(joystick_index))
        return "" if value <= 0 else str(value)

    @staticmethod
    def _controller_info(joystick_index: int) -> dict[str, object]:
        name_ptr = sdl2.SDL_GameControllerNameForIndex(joystick_index)
        name = "unknown" if name_ptr is None else name_ptr.decode("utf-8")
        return {
            "index": joystick_index,
            "name": name,
            "guid": SDLGameController._device_guid(joystick_index),
            "path": SDLGameController._device_string(
                joystick_index, "SDL_GameControllerPathForIndex"
            ),
            "vendor": SDLGameController._device_integer(
                joystick_index, "SDL_JoystickGetDeviceVendor"
            ),
            "product": SDLGameController._device_integer(
                joystick_index, "SDL_JoystickGetDeviceProduct"
            ),
            "product_version": SDLGameController._device_integer(
                joystick_index, "SDL_JoystickGetDeviceProductVersion"
            ),
        }

    @staticmethod
    def _matches_selected_controller(
        controller: dict[str, object], selected: dict[str, str] | None
    ) -> bool:
        if selected is None:
            return True

        matched_field = False
        for field_name in CONTROLLER_CONFIG_FIELDS:
            selected_value = selected.get(field_name, "")
            if not selected_value:
                continue
            matched_field = True
            controller_value = str(controller.get(field_name, "")).strip()
            if not controller_value:
                return False
            if field_name == "name":
                if selected_value.lower() not in controller_value.lower():
                    return False
            elif selected_value.lower() != controller_value.lower():
                return False
        return matched_field

    @staticmethod
    def list_available_controllers() -> list[dict[str, object]]:
        initialized_here = False
        if sdl2.SDL_WasInit(sdl2.SDL_INIT_GAMECONTROLLER) == 0:
            if sdl2.SDL_Init(sdl2.SDL_INIT_GAMECONTROLLER) != 0:
                error = sdl2.SDL_GetError().decode("utf-8")
                message = f"SDL_Init failed: {error}"
                raise RuntimeError(message)
            initialized_here = True
        try:
            controllers: list[dict[str, object]] = []
            count = sdl2.SDL_NumJoysticks()
            for joystick_index in range(count):
                if sdl2.SDL_IsGameController(joystick_index) == 0:
                    continue
                controllers.append(
                    SDLGameController._controller_info(joystick_index)
                )
            return controllers
        finally:
            if initialized_here:
                sdl2.SDL_QuitSubSystem(sdl2.SDL_INIT_GAMECONTROLLER)

    def _try_open_controller(self) -> bool:
        count = sdl2.SDL_NumJoysticks()
        for joystick_index in range(count):
            if sdl2.SDL_IsGameController(joystick_index) == 0:
                continue
            controller_info = self._controller_info(joystick_index)
            guid = str(controller_info.get("guid", ""))
            name = str(controller_info.get("name", "unknown"))

            if (
                self.selected_guid
                and guid.lower() != self.selected_guid.lower()
            ):
                continue
            if (
                self.name_filter
                and self.name_filter.lower() not in name.lower()
            ):
                continue
            if (
                self.selected_controller is not None
                and not self._matches_selected_controller(
                    controller_info, self.selected_controller
                )
            ):
                continue

            controller = sdl2.SDL_GameControllerOpen(joystick_index)
            if not controller:
                logger.warning(
                    "Failed to open SDL game controller index %s: %s",
                    joystick_index,
                    sdl2.SDL_GetError().decode("utf-8"),
                )
                continue

            joystick = sdl2.SDL_GameControllerGetJoystick(controller)
            self._controller = controller
            self._instance_id = int(sdl2.SDL_JoystickInstanceID(joystick))
            self._active_controller_info = controller_info
            announce(f"Connected to controller: {name} (guid={guid})", logger)
            return True
        return False

    def _selection_signature(
        self,
    ) -> tuple[str | None, str | None, tuple[str, ...]]:
        selection_values: tuple[str, ...] = ()
        if self.selected_controller is not None:
            selection_values = tuple(
                self.selected_controller.get(field_name, "")
                for field_name in CONTROLLER_CONFIG_FIELDS
            )
        return (self.selected_guid, self.name_filter, selection_values)

    def _apply_selection(
        self, selected: dict[str, str] | None, *, announce_change: bool
    ) -> None:
        guid = selected.get("guid") if selected else None
        name_filter = selected.get("name") if selected else None
        normalized_guid = guid or None
        normalized_name = name_filter or None
        old_signature = self._selection_signature()
        self.selected_guid = normalized_guid
        self.name_filter = normalized_name
        self.selected_controller = selected
        if self._selection_signature() == old_signature:
            return
        if announce_change:
            announce(
                f"Controller target changed to: {self._target_description()}",
                logger,
            )
        if self._controller is not None:
            sdl2.SDL_GameControllerClose(self._controller)
            self._controller = None
            self._instance_id = None
            self._active_controller_info = None

    def reload_selection_from_config(self, path: Path) -> None:
        try:
            stat = path.stat()
            mtime_ns: int | None = stat.st_mtime_ns
        except FileNotFoundError:
            mtime_ns = None
        if mtime_ns == self._selection_mtime_ns:
            return
        self._selection_mtime_ns = mtime_ns
        selected = _load_selected_controller(path)
        self._apply_selection(selected, announce_change=True)

    def _wait_for_controller(
        self,
        monitor: GamepadMonitor,
        *,
        announced_waiting: bool,
        report_connection_state: Callable[[], None],
    ) -> bool:
        if self._controller is not None:
            return announced_waiting
        if self._try_open_controller():
            report_connection_state()
            monitor.on_start(self, list(self.inputs.values()))
            if announced_waiting:
                announce(
                    f"Controller reconnected: {self._target_description()}",
                    logger,
                )
            return False
        if not announced_waiting:
            announce(
                "Disconnected, waiting for controller connection: "
                f"{self._target_description()}",
                logger,
            )
        report_connection_state()
        return True

    def _handle_read_loop_event(
        self,
        event: sdl2.SDL_Event,
        monitor: GamepadMonitor,
        *,
        device_change_callback: Callable[[], None] | None,
        report_connection_state: Callable[[], None],
    ) -> None:
        if (
            event.type
            in (
                sdl2.SDL_CONTROLLERDEVICEADDED,
                sdl2.SDL_CONTROLLERDEVICEREMOVED,
            )
            and device_change_callback is not None
        ):
            device_change_callback()

        updated = self._handle_event(event, monitor)
        report_connection_state()
        if updated:
            monitor.on_sync(self)

    def close(self) -> None:
        if self._controller:
            sdl2.SDL_GameControllerClose(self._controller)
            self._controller = None
            self._instance_id = None
            self._active_controller_info = None
        sdl2.SDL_QuitSubSystem(sdl2.SDL_INIT_GAMECONTROLLER)

    def read_loop(
        self,
        monitor: GamepadMonitor,
        *,
        selection_path: Path | None = None,
        stop_event: Event | None = None,
        device_change_callback: Callable[[], None] | None = None,
        active_controller_callback: (
            Callable[[dict[str, object] | None], None] | None
        ) = None,
    ) -> None:
        event = sdl2.SDL_Event()
        announced_waiting = False
        reported_active_controller: dict[str, object] | None = None

        def report_active_controller() -> None:
            nonlocal reported_active_controller
            active_controller = self._active_controller_info
            if active_controller == reported_active_controller:
                return
            reported_active_controller = active_controller
            if active_controller_callback is not None:
                active_controller_callback(active_controller)

        announce(f"Controller target: {self._target_description()}", logger)
        try:
            while stop_event is None or not stop_event.is_set():
                if selection_path is not None:
                    self.reload_selection_from_config(selection_path)
                    report_active_controller()
                announced_waiting = self._wait_for_controller(
                    monitor,
                    announced_waiting=announced_waiting,
                    report_connection_state=report_active_controller,
                )

                if sdl2.SDL_WaitEventTimeout(event, 2000) == 0:
                    continue

                self._handle_read_loop_event(
                    event,
                    monitor,
                    device_change_callback=device_change_callback,
                    report_connection_state=report_active_controller,
                )
        finally:
            if reported_active_controller is not None:
                reported_active_controller = None
                if active_controller_callback is not None:
                    active_controller_callback(None)

    def _handle_event(
        self, event: sdl2.SDL_Event, monitor: GamepadMonitor
    ) -> bool:
        if event.type == sdl2.SDL_CONTROLLERAXISMOTION:
            return self._handle_axis_event(event, monitor)

        if event.type in (
            sdl2.SDL_CONTROLLERBUTTONDOWN,
            sdl2.SDL_CONTROLLERBUTTONUP,
        ):
            return self._handle_button_event(event, monitor)

        if (
            event.type == sdl2.SDL_CONTROLLERDEVICEREMOVED
            and self._instance_id is not None
            and int(event.cdevice.which) == self._instance_id
        ):
            announce(
                "Controller disconnected, waiting for reconnection: "
                f"{self._target_description()}",
                logger,
                level=logging.WARNING,
            )
            if self._controller is not None:
                sdl2.SDL_GameControllerClose(self._controller)
            self._controller = None
            self._instance_id = None
            self._active_controller_info = None
            return False

        if event.type == sdl2.SDL_CONTROLLERDEVICEADDED:
            return False

        return False

    def _handle_axis_event(
        self, event: sdl2.SDL_Event, monitor: GamepadMonitor
    ) -> bool:
        if int(event.caxis.which) != self._instance_id:
            return False
        mapped = SDL_AXIS_MAP.get(int(event.caxis.axis))
        if mapped is None:
            return False

        _, target, input_range = mapped
        gamepad_input = self.inputs[target]
        value = input_range.clamp(int(event.caxis.value))
        monitor.on_update(self, gamepad_input, value)
        return True

    def _handle_button_event(
        self, event: sdl2.SDL_Event, monitor: GamepadMonitor
    ) -> bool:
        if int(event.cbutton.which) != self._instance_id:
            return False

        button = int(event.cbutton.button)
        value = 1 if event.type == sdl2.SDL_CONTROLLERBUTTONDOWN else 0

        dpad_handlers: dict[int, tuple[str, bool]] = {
            sdl2.SDL_CONTROLLER_BUTTON_DPAD_LEFT: ("_dpad_left", True),
            sdl2.SDL_CONTROLLER_BUTTON_DPAD_RIGHT: ("_dpad_right", True),
            sdl2.SDL_CONTROLLER_BUTTON_DPAD_UP: ("_dpad_up", False),
            sdl2.SDL_CONTROLLER_BUTTON_DPAD_DOWN: ("_dpad_down", False),
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
    controller_guid: str | None = None
    controller_name: str | None = None
    lan: bool = False
    terminal: bool = False
    stop_event: Event | None = None
    device_change_callback: Callable[[], None] | None = None
    active_controller_callback: (
        Callable[[dict[str, object] | None], None] | None
    ) = None
    client_count_callback: Callable[[int], None] | None = None


@dataclass
class TerminalGamepadMonitor:
    state: dict[str, float] = field(default_factory=dict)

    def on_start(
        self, _controller: SDLGameController, inputs: list[Input]
    ) -> None:
        logger.info(f"START: initializing {len(inputs)} inputs.")
        self.state = {
            gamepad_input.identifier.user.name: 0.0
            for gamepad_input in inputs
            if gamepad_input.identifier.user
        }
        self.broadcast()

    def on_sync(self, _controller: SDLGameController) -> None:
        self.broadcast()

    def broadcast(self) -> None:
        print(f"STATE: {self}")

    def on_update(
        self, _controller: SDLGameController, gamepad_input: Input, value: int
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

    def on_start(
        self, _controller: SDLGameController, inputs: list[Input]
    ) -> None:
        logger.info(f"START: initializing {len(inputs)} inputs.")
        self.state = {
            gamepad_input.identifier.user.name: 0.0
            for gamepad_input in inputs
            if gamepad_input.identifier.user
        }
        self.broadcast()

    def on_sync(self, _controller: SDLGameController) -> None:
        self.broadcast()

    def broadcast(self) -> None:
        self.websocket_broadcaster.send_state(self.state)

    def on_update(
        self, _controller: SDLGameController, gamepad_input: Input, value: int
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
        description=importlib.metadata.metadata(__package__).get("summary")
    )
    output_group = parser.add_mutually_exclusive_group()
    output_group.add_argument(
        "--lan",
        action="store_true",
        help="Allow websocket connections from other machines on the LAN.",
    )
    output_group.add_argument(
        "--terminal",
        action="store_true",
        help="Print state to terminal instead of broadcasting to websocket.",
    )
    parser.add_argument(
        "--list-controllers",
        action="store_true",
        help="List connected controllers and exit.",
    )
    parser.add_argument("--controller-guid", help="Select controller by GUID.")
    parser.add_argument(
        "--controller-name",
        help="Select controller by case-insensitive name substring.",
    )
    parser.add_argument(
        "--any-controller",
        action="store_true",
        help="Clear the saved controller selection and use any controller.",
    )
    parser.add_argument(
        "--select-controller",
        action="store_true",
        help="Interactively select a connected controller and save it.",
    )
    parser.add_argument(
        "--headless",
        action="store_true",
        help="Run the websocket server directly without the Qt tray.",
    )
    parser.add_argument(
        "--hide",
        action="store_true",
        help="Start the Qt tray with the selector window hidden.",
    )
    add_log_arguments(parser)
    return parser


def _print_available_controllers() -> int:
    controllers = SDLGameController.list_available_controllers()
    if not controllers:
        print("No compatible controllers detected.")
        return 0
    for controller_info in controllers:
        print(
            f"[{controller_info['index']}] {controller_info['name']}"
            f" guid={controller_info['guid']}"
        )
    return 0


def _format_hex_identifier(value: object) -> str:
    text = str(value or "").strip()
    if not text:
        return ""
    try:
        return f"{int(text):04x}"
    except ValueError:
        return text


def _controller_vid_pid(controller: dict[str, object]) -> str:
    vendor = _format_hex_identifier(controller.get("vendor"))
    product = _format_hex_identifier(controller.get("product"))
    if vendor and product:
        return f"{vendor}:{product}"
    return ""


def _controller_metadata_summary(
    controller: dict[str, object], *, version_first: bool
) -> str:
    product_version = str(controller.get("product_version", "")).strip()
    version_part = f"v{product_version}" if product_version else ""
    id_parts: list[str] = []
    vendor_product = _controller_vid_pid(controller)
    if vendor_product:
        id_parts.append(f"[{vendor_product}]")
    guid = str(controller.get("guid", "")).strip()
    if guid:
        id_parts.append(f"[{guid}]")
    if version_first:
        parts = [version_part, *id_parts]
    else:
        parts = [*id_parts, version_part]
    return " ".join(part for part in parts if part)


def _select_and_save_controller(config_path: Path) -> int:
    selected = _interactive_select_controller()
    if selected is None:
        print("No controller selected.")
        return 1
    if not selected:
        _clear_selected_controller(config_path)
        print("Will use any controller.")
        return 0
    _save_selected_controller(config_path, selected)
    print(
        "Saved selected controller: "
        f"{selected['name']} (guid={selected['guid']})"
    )
    return 0


def _save_explicit_selection(
    args: argparse.Namespace, config_path: Path
) -> None:
    if args.controller_guid:
        _save_selected_controller(
            config_path,
            {"guid": args.controller_guid, "name": args.controller_name or ""},
        )
    elif args.controller_name:
        _save_selected_controller(
            config_path, {"guid": "", "name": args.controller_name}
        )


def _run_tray(args: argparse.Namespace, config_path: Path) -> int:
    from .tray import run_tray

    return run_tray(
        config_path=config_path,
        lan=args.lan,
        terminal=args.terminal,
        start_hidden=args.hide,
    )


def run_server(config: ServerRunConfig) -> int:
    selected_config = _load_selected_controller(config.config_path)
    selected_guid = config.controller_guid or (
        selected_config.get("guid") if selected_config else None
    )
    selected_name = (
        config.controller_name
        if config.controller_name is not None
        else (selected_config.get("name") if selected_config else None)
    )

    if config.terminal:
        monitor: GamepadMonitor = TerminalGamepadMonitor()
    else:
        bind_host = "0.0.0.0" if config.lan else "localhost"  # noqa: S104
        websocket_broadcaster = WebSocketBroadcaster(
            8765,
            host=bind_host,
            path="/gamepad-overlay",
            banner="gamepad-overlay",
            client_count_callback=config.client_count_callback,
        )
        monitor = WebSocketGamepadMonitor(
            websocket_broadcaster=websocket_broadcaster
        )

    controller = SDLGameController(
        selected_guid=selected_guid or None,
        name_filter=selected_name or None,
        selected_controller=(
            None
            if config.controller_guid or config.controller_name
            else selected_config
        ),
    )
    selection_watch_path = (
        None
        if config.controller_guid or config.controller_name
        else config.config_path
    )
    try:
        controller.read_loop(
            monitor,
            selection_path=selection_watch_path,
            stop_event=config.stop_event,
            device_change_callback=config.device_change_callback,
            active_controller_callback=config.active_controller_callback,
        )
    except KeyboardInterrupt:
        announce("\nExiting.", logger)
    finally:
        controller.close()
    return 0


def _run_headless_server(args: argparse.Namespace, config_path: Path) -> int:
    return run_server(
        ServerRunConfig(
            config_path=config_path,
            controller_guid=args.controller_guid,
            controller_name=args.controller_name,
            lan=args.lan,
            terminal=args.terminal,
        )
    )


def main(argv: Sequence[str] | None = None) -> int:
    parser = _build_parser()
    args = parser.parse_args(args=argv)
    configure_logging(args)

    config_path = _controller_config_path()

    if args.list_controllers:
        return _print_available_controllers()

    if args.any_controller:
        _clear_selected_controller(config_path)
        print("Will use any controller.")
        return 0

    if args.select_controller:
        return _select_and_save_controller(config_path)

    _save_explicit_selection(args, config_path)

    if not args.headless:
        return _run_tray(args, config_path)

    return _run_headless_server(args, config_path)


def _controller_config_path() -> Path:
    config_home = os.environ.get("XDG_CONFIG_HOME")
    base = Path(config_home) if config_home else Path.home() / ".config"
    return base / "gamepad-websocket-server" / CONFIG_FILE_NAME


def _load_selected_controller(path: Path) -> dict[str, str] | None:
    if not path.exists():
        return None
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        logger.warning("Failed to read controller config at %s", path)
        return None
    guid = str(payload.get("guid", "")).strip()
    name = str(payload.get("name", "")).strip()
    vendor = str(payload.get("vendor", "")).strip()
    product = str(payload.get("product", "")).strip()
    if not any([guid, name, vendor, product]):
        return None
    return {"guid": guid, "vendor": vendor, "product": product, "name": name}


def _save_selected_controller(path: Path, selected: dict[str, object]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    data = {
        field_name: str(selected.get(field_name, "")).strip()
        for field_name in CONTROLLER_CONFIG_FIELDS
    }
    path.write_text(json.dumps(data, indent=2) + "\n", encoding="utf-8")


def _clear_selected_controller(path: Path) -> None:
    try:
        path.unlink()
    except FileNotFoundError:
        return


def _interactive_select_controller() -> dict[str, object] | None:
    controllers = SDLGameController.list_available_controllers()
    if not controllers:
        print("No compatible controllers detected.")
        return None
    print("Detected controllers:")
    for idx, controller in enumerate(controllers, start=1):
        print(f"  {idx}) {controller['name']}")
        metadata = _controller_metadata_summary(
            controller, version_first=False
        )
        if metadata:
            print(f"     - {metadata}")
    print("  0) (any controller)")
    print()
    while True:
        try:
            choice = input(
                "Select controller number (0 for any, or blank to cancel): "
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
        if 1 <= selected_index <= len(controllers):
            return controllers[selected_index - 1]
        print("Selection out of range.")

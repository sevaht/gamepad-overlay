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
    from collections.abc import Sequence

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
    preferred_guid: str | None = None
    name_filter: str | None = None
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

    def __post_init__(self) -> None:
        if sdl2.SDL_Init(sdl2.SDL_INIT_GAMECONTROLLER) != 0:
            error = sdl2.SDL_GetError().decode("utf-8")
            message = f"SDL_Init failed: {error}"
            raise RuntimeError(message)

        sdl2.SDL_GameControllerEventState(sdl2.SDL_ENABLE)

    def _target_description(self) -> str:
        if self.preferred_guid:
            return f"guid={self.preferred_guid}"
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
                name_ptr = sdl2.SDL_GameControllerNameForIndex(joystick_index)
                name = (
                    "unknown" if name_ptr is None else name_ptr.decode("utf-8")
                )
                controllers.append(
                    {
                        "index": joystick_index,
                        "name": name,
                        "guid": SDLGameController._device_guid(joystick_index),
                    }
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
            guid = self._device_guid(joystick_index)
            name_ptr = sdl2.SDL_GameControllerNameForIndex(joystick_index)
            name = "unknown" if name_ptr is None else name_ptr.decode("utf-8")

            if (
                self.preferred_guid
                and guid.lower() != self.preferred_guid.lower()
            ):
                continue
            if (
                self.name_filter
                and self.name_filter.lower() not in name.lower()
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
            announce(f"Connected to controller: {name} (guid={guid})", logger)
            return True
        return False

    def _selection_signature(self) -> tuple[str | None, str | None]:
        return (self.preferred_guid, self.name_filter)

    def _apply_selection(
        self,
        guid: str | None,
        name_filter: str | None,
        *,
        announce_change: bool,
    ) -> None:
        normalized_guid = guid or None
        normalized_name = name_filter or None
        old_signature = self._selection_signature()
        new_signature = (normalized_guid, normalized_name)
        if new_signature == old_signature:
            return
        self.preferred_guid = normalized_guid
        self.name_filter = normalized_name
        if announce_change:
            announce(
                f"Controller target changed to: {self._target_description()}",
                logger,
            )
        if self._controller is not None:
            sdl2.SDL_GameControllerClose(self._controller)
            self._controller = None
            self._instance_id = None

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
        guid = selected.get("guid") if selected else None
        name_filter = selected.get("name") if selected else None
        self._apply_selection(guid, name_filter, announce_change=True)

    def close(self) -> None:
        if self._controller:
            sdl2.SDL_GameControllerClose(self._controller)
            self._controller = None
            self._instance_id = None
        sdl2.SDL_QuitSubSystem(sdl2.SDL_INIT_GAMECONTROLLER)

    def read_loop(
        self, monitor: GamepadMonitor, *, selection_path: Path | None = None
    ) -> None:
        event = sdl2.SDL_Event()
        announced_waiting = False
        announce(f"Controller target: {self._target_description()}", logger)
        while True:
            if selection_path is not None:
                self.reload_selection_from_config(selection_path)
            if self._controller is None:
                if self._try_open_controller():
                    monitor.on_start(self, list(self.inputs.values()))
                    if announced_waiting:
                        announce(
                            f"Controller reconnected: {self._target_description()}",
                            logger,
                        )
                    announced_waiting = False
                elif not announced_waiting:
                    announce(
                        "Disconnected, waiting for controller connection: "
                        f"{self._target_description()}",
                        logger,
                    )
                    announced_waiting = True

            if sdl2.SDL_WaitEventTimeout(event, 2000) == 0:
                continue

            updated = self._handle_event(event, monitor)
            if updated:
                monitor.on_sync(self)

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


def main(argv: Sequence[str] | None = None) -> int:
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
        "--select-controller",
        action="store_true",
        help="Interactively select a connected controller and save it.",
    )
    add_log_arguments(parser)
    args = parser.parse_args(args=argv)
    configure_logging(args)

    config_path = _controller_config_path()

    if args.list_controllers:
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

    if args.select_controller:
        selected = _interactive_select_controller()
        if selected is None:
            print("No controller selected.")
            return 1
        _save_selected_controller(config_path, selected)
        print(
            "Saved preferred controller: "
            f"{selected['name']} (guid={selected['guid']})"
        )
        return 0

    selected_config = _load_selected_controller(config_path)
    selected_guid = args.controller_guid or (
        selected_config.get("guid") if selected_config else None
    )
    selected_name = (
        args.controller_name
        if args.controller_name is not None
        else (selected_config.get("name") if selected_config else None)
    )

    if args.controller_guid:
        _save_selected_controller(
            config_path,
            {"guid": args.controller_guid, "name": args.controller_name or ""},
        )
    elif args.controller_name:
        _save_selected_controller(
            config_path, {"guid": "", "name": args.controller_name}
        )
    if args.terminal:
        monitor: GamepadMonitor = TerminalGamepadMonitor()
    else:
        bind_host = "0.0.0.0" if args.lan else "localhost"  # noqa: S104
        websocket_broadcaster = WebSocketBroadcaster(
            8765,
            host=bind_host,
            path="/gamepad-overlay",
            banner="gamepad-overlay",
        )
        monitor = WebSocketGamepadMonitor(
            websocket_broadcaster=websocket_broadcaster
        )

    controller = SDLGameController(
        preferred_guid=selected_guid or None, name_filter=selected_name or None
    )
    selection_watch_path = (
        None if args.controller_guid or args.controller_name else config_path
    )
    try:
        controller.read_loop(monitor, selection_path=selection_watch_path)
    except KeyboardInterrupt:
        announce("\nExiting.", logger)
    finally:
        controller.close()
    return 0


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
    if not guid and not name:
        return None
    return {"guid": guid, "name": name}


def _save_selected_controller(path: Path, selected: dict[str, object]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    data = {
        "guid": str(selected.get("guid", "")).strip(),
        "name": str(selected.get("name", "")).strip(),
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
        print(
            f"  {idx}) {controller['name']}"
            f" (index={controller['index']}, guid={controller['guid']})"
        )
    while True:
        choice = input(
            "Select controller number (or blank to cancel): "
        ).strip()
        if choice == "":
            return None
        if not choice.isdigit():
            print("Invalid selection. Enter a number.")
            continue
        selected_index = int(choice)
        if 1 <= selected_index <= len(controllers):
            return controllers[selected_index - 1]
        print("Selection out of range.")

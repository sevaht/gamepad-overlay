from __future__ import annotations

import ctypes
import json
import logging
import platform
from dataclasses import dataclass, field
from enum import IntEnum, auto, unique
from pathlib import Path
from typing import TYPE_CHECKING, Any, Protocol

import sdl3

from .cli_output import announce

if TYPE_CHECKING:
    from collections.abc import Callable
    from threading import Event

CONFIG_FILE_NAME = "config.json"

logger = logging.getLogger(__name__)


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


def _format_hex_identifier(value: object) -> str:
    text = str(value or "").strip()
    if not text:
        return ""
    try:
        return f"{int(text):04x}"
    except ValueError:
        return text


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
    return device_path


def port_display_name(port: str) -> str:
    """Return a concise display form of a port path (strips PCI prefix on Linux)."""
    usb_idx = port.find("usb-")
    return port[usb_idx:] if usb_idx != -1 else port


@dataclass(frozen=True)
class GamepadInfo:
    index: int
    name: str
    guid: str
    path: str
    port: str
    vendor: str
    product: str
    product_version: str

    def vid_pid(self) -> str:
        v = _format_hex_identifier(self.vendor)
        p = _format_hex_identifier(self.product)
        return f"{v}:{p}" if v and p else ""

    def metadata_summary(self) -> str:
        id_parts: list[str] = []
        vp = self.vid_pid()
        if vp:
            id_parts.append(f"[{vp}]")
        elif self.guid:
            id_parts.append(f"[{self.guid}]")
        if self.port:
            id_parts.append(f"[{port_display_name(self.port)}]")
        return " ".join(id_parts)

    def as_selection(
        self, *, pin_identity: bool = True, pin_port: bool = False
    ) -> GamepadSelection:
        return GamepadSelection(
            guid=self.guid if pin_identity else "",
            vendor=self.vendor if pin_identity else "",
            product=self.product if pin_identity else "",
            port=self.port if pin_port else "",
            name=self.name,
        )


@dataclass(frozen=True)
class GamepadSelection:
    guid: str = ""
    vendor: str = ""
    product: str = ""
    port: str = ""
    name: str = field(default="", compare=False)

    def is_any(self) -> bool:
        return not any([self.guid, self.vendor, self.product, self.port])

    def metadata_summary(self) -> str:
        parts: list[str] = []
        v = _format_hex_identifier(self.vendor)
        p = _format_hex_identifier(self.product)
        if v and p:
            parts.append(f"[{v}:{p}]")
        elif v or p:
            parts.append(f"[{v or '????'}:{p or '????'}]")
        if self.port:
            parts.append(f"[{port_display_name(self.port)}]")
        return " ".join(parts)

    def matches(self, gamepad: GamepadInfo) -> bool:
        matched = False
        for sel_val, gpad_val in (
            (self.guid, gamepad.guid),
            (self.vendor, gamepad.vendor),
            (self.product, gamepad.product),
            (self.port, gamepad.port),
        ):
            if not sel_val:
                continue
            matched = True
            if not gpad_val or sel_val.lower() != gpad_val.lower():
                return False
        return matched

    def target_description(self) -> str:
        if self.is_any():
            return "any gamepad"
        has_identity = bool(self.guid or self.vendor or self.product)
        port = self.port
        name = self.name or "unknown controller"
        vp = _format_hex_identifier(self.vendor)
        pp = _format_hex_identifier(self.product)
        vid_pid = f"{vp}:{pp}" if vp and pp else ""
        if vid_pid:
            name_str = f"{name} [{vid_pid}]"
        elif has_identity:
            name_str = f"{name} [{self.guid}]" if self.guid else name
        else:
            name_str = name
        if has_identity and port:
            return f"{name_str} on {port_display_name(port)}"
        if has_identity:
            return f"{name_str} (any port)"
        if port:
            return f"any controller on {port_display_name(port)}"
        return "any gamepad"

    def save(self, path: Path) -> None:
        path.parent.mkdir(parents=True, exist_ok=True)
        try:
            config: dict[str, object] = json.loads(
                path.read_text(encoding="utf-8")
            )
            if not isinstance(config, dict):
                config = {}
        except Exception:  # noqa: BLE001
            config = {}
        config["selection"] = {
            key: value
            for key, value in (
                ("guid", self.guid),
                ("vendor", self.vendor),
                ("product", self.product),
                ("port", self.port),
                ("name", self.name),
            )
            if value
        }
        path.write_text(json.dumps(config, indent=2) + "\n", encoding="utf-8")

    @classmethod
    def load(cls, path: Path) -> GamepadSelection | None:
        if not path.exists():
            return None
        try:
            config = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            logger.warning("Failed to read config at %s", path)
            return None
        if not isinstance(config, dict):
            return None
        payload = config.get("selection")
        if not isinstance(payload, dict):
            return None
        result = cls(
            guid=str(payload.get("guid", "")).strip(),
            vendor=str(payload.get("vendor", "")).strip(),
            product=str(payload.get("product", "")).strip(),
            port=str(payload.get("port", "")).strip(),
            name=str(payload.get("name", "")).strip(),
        )
        return None if result.is_any() else result

    @staticmethod
    def clear(path: Path) -> None:
        if not path.exists():
            return
        try:
            config = json.loads(path.read_text(encoding="utf-8"))
            if isinstance(config, dict) and "selection" in config:
                del config["selection"]
                path.write_text(
                    json.dumps(config, indent=2) + "\n", encoding="utf-8"
                )
        except Exception:  # noqa: BLE001, S110
            pass


@dataclass
class SDLGamepad:
    selected_gamepad: GamepadSelection | None = None
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
    _active_gamepad_info: GamepadInfo | None = field(default=None, init=False)

    def __post_init__(self) -> None:
        if not sdl3.SDL_Init(sdl3.SDL_INIT_GAMEPAD):
            error = sdl3.SDL_GetError().decode("utf-8")
            message = f"SDL_Init failed: {error}"
            raise RuntimeError(message)

        sdl3.SDL_SetGamepadEventsEnabled(True)

    def _target_description(self) -> str:
        if self.selected_gamepad is not None:
            return self.selected_gamepad.target_description()
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
    def _gamepad_info(gamepad_id: int) -> GamepadInfo:
        name_ptr = sdl3.SDL_GetGamepadNameForID(gamepad_id)
        name = "unknown" if name_ptr is None else name_ptr.decode("utf-8")
        sdl_path = SDLGamepad._device_string(
            gamepad_id, "SDL_GetGamepadPathForID"
        )
        return GamepadInfo(
            index=gamepad_id,
            name=name,
            guid=SDLGamepad._device_guid(gamepad_id),
            path=sdl_path,
            port=_get_device_port_path(sdl_path),
            vendor=SDLGamepad._device_integer(
                gamepad_id, "SDL_GetGamepadVendorForID"
            ),
            product=SDLGamepad._device_integer(
                gamepad_id, "SDL_GetGamepadProductForID"
            ),
            product_version=SDLGamepad._device_integer(
                gamepad_id, "SDL_GetGamepadProductVersionForID"
            ),
        )

    @staticmethod
    def list_available_gamepads() -> list[GamepadInfo]:
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
            name = gamepad_info.name

            if (
                self.selected_gamepad is not None
                and not self.selected_gamepad.matches(gamepad_info)
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
            metadata = gamepad_info.metadata_summary()
            suffix = f" {metadata}" if metadata else ""
            announce(f"Connected to gamepad: {name}{suffix}", logger)
            return True
        return False

    def _release_gamepad(self) -> None:
        if self._gamepad is not None:
            sdl3.SDL_CloseGamepad(self._gamepad)
        self._gamepad = None
        self._gamepad_id = None
        self._active_gamepad_info = None

    def _apply_selection(
        self, selected: GamepadSelection | None, *, announce_change: bool
    ) -> None:
        old_selection = self.selected_gamepad
        self.selected_gamepad = selected
        if self.selected_gamepad == old_selection:
            return
        if announce_change:
            announce(
                f"Gamepad target changed to: {self._target_description()}",
                logger,
            )
        self._release_gamepad()

    def reload_selection_from_config(self, path: Path) -> None:
        try:
            stat = path.stat()
            mtime_ns: int | None = stat.st_mtime_ns
        except FileNotFoundError:
            mtime_ns = None
        if mtime_ns == self._selection_mtime_ns:
            return
        self._selection_mtime_ns = mtime_ns
        selected = GamepadSelection.load(path)
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
        self._release_gamepad()
        sdl3.SDL_QuitSubSystem(sdl3.SDL_INIT_GAMEPAD)

    def read_loop(
        self,
        monitor: GamepadMonitor,
        *,
        selection_path: Path | None = None,
        stop_event: Event | None = None,
        device_change_callback: Callable[[], None] | None = None,
        active_gamepad_callback: (
            Callable[[GamepadInfo | None], None] | None
        ) = None,
    ) -> None:
        event = sdl3.SDL_Event()
        announced_waiting = False
        reported_active_gamepad: GamepadInfo | None = None

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
            self._release_gamepad()
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

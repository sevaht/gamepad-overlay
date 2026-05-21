from __future__ import annotations

from typing import Any

SDL_INIT_GAMECONTROLLER: int
SDL_ENABLE: int

SDL_CONTROLLERAXISMOTION: int
SDL_CONTROLLERBUTTONDOWN: int
SDL_CONTROLLERBUTTONUP: int
SDL_CONTROLLERDEVICEREMOVED: int
SDL_CONTROLLERDEVICEADDED: int

SDL_CONTROLLER_BUTTON_A: int
SDL_CONTROLLER_BUTTON_B: int
SDL_CONTROLLER_BUTTON_X: int
SDL_CONTROLLER_BUTTON_Y: int
SDL_CONTROLLER_BUTTON_BACK: int
SDL_CONTROLLER_BUTTON_START: int
SDL_CONTROLLER_BUTTON_GUIDE: int
SDL_CONTROLLER_BUTTON_LEFTSHOULDER: int
SDL_CONTROLLER_BUTTON_RIGHTSHOULDER: int
SDL_CONTROLLER_BUTTON_LEFTSTICK: int
SDL_CONTROLLER_BUTTON_RIGHTSTICK: int
SDL_CONTROLLER_BUTTON_DPAD_LEFT: int
SDL_CONTROLLER_BUTTON_DPAD_RIGHT: int
SDL_CONTROLLER_BUTTON_DPAD_UP: int
SDL_CONTROLLER_BUTTON_DPAD_DOWN: int

SDL_CONTROLLER_AXIS_LEFTX: int
SDL_CONTROLLER_AXIS_LEFTY: int
SDL_CONTROLLER_AXIS_RIGHTX: int
SDL_CONTROLLER_AXIS_RIGHTY: int
SDL_CONTROLLER_AXIS_TRIGGERLEFT: int
SDL_CONTROLLER_AXIS_TRIGGERRIGHT: int

class SDL_GameController: ...
class SDL_Joystick: ...
class SDL_JoystickGUID: ...

class _ControllerAxisEvent:
    which: int
    axis: int
    value: int

class _ControllerButtonEvent:
    which: int
    button: int

class _ControllerDeviceEvent:
    which: int

class SDL_Event:
    type: int
    caxis: _ControllerAxisEvent
    cbutton: _ControllerButtonEvent
    cdevice: _ControllerDeviceEvent

def SDL_Init(flags: int) -> int: ...
def SDL_WasInit(flags: int) -> int: ...
def SDL_QuitSubSystem(flags: int) -> None: ...
def SDL_GetError() -> bytes: ...
def SDL_ClearError() -> None: ...
def SDL_GameControllerEventState(state: int) -> int: ...
def SDL_NumJoysticks() -> int: ...
def SDL_IsGameController(joystick_index: int) -> int: ...
def SDL_GameControllerNameForIndex(joystick_index: int) -> bytes | None: ...
def SDL_GameControllerOpen(
    joystick_index: int,
) -> SDL_GameController | None: ...
def SDL_GameControllerClose(controller: SDL_GameController) -> None: ...
def SDL_GameControllerGetJoystick(
    controller: SDL_GameController,
) -> SDL_Joystick: ...
def SDL_JoystickGetDeviceGUID(joystick_index: int) -> SDL_JoystickGUID: ...
def SDL_JoystickGetGUIDString(
    guid: SDL_JoystickGUID, psz_guid: Any, cb_guid: int
) -> None: ...
def SDL_JoystickInstanceID(joystick: SDL_Joystick) -> int: ...
def SDL_WaitEventTimeout(event: SDL_Event, timeout: int) -> int: ...

# Gamepad WebSocket Server

Local websocket server for the overlay in `../overlay/`.

This is the intended production input source for OBS usage.

## Requirements

- Python 3.11+
- `uv`
- SDL2-compatible runtime available

Platform notes:

- Windows: `uv sync` should install the required SDL2 DLL package automatically.
- Linux: you still need an SDL2-compatible runtime on the system. A normal SDL2 package works, and `sdl2-compat` should also be fine if it provides the SDL2 library that `pysdl2` loads.

## Run

Linux:

```bash
cd server
uv sync
uv run gamepad-websocket-server
```

Windows (PowerShell):

```powershell
cd server
uv sync
uv run gamepad-websocket-server
```

The server listens on:

- host: `localhost` by default
- port: `8765`
- path: `/gamepad-overlay`

The matching overlay websocket URL is:

```text
ws://localhost:8765/gamepad-overlay
```

## Useful Commands

List controllers:

```bash
uv run gamepad-websocket-server --list-controllers
```

Interactively select and save a preferred controller:

```bash
uv run gamepad-websocket-server --select-controller
```

Select controller by GUID:

```bash
uv run gamepad-websocket-server --controller-guid <guid>
```

Select controller by name substring:

```bash
uv run gamepad-websocket-server --controller-name "Xbox"
```

Allow websocket access from other machines on the LAN:

```bash
uv run gamepad-websocket-server --lan
```

Print controller state to the terminal instead of serving websocket:

```bash
uv run gamepad-websocket-server --terminal
```

## Controller Selection Persistence

Preferred controller selection is persisted to:

- Linux: `~/.config/gamepad-websocket-server/controller-selection.json` unless `XDG_CONFIG_HOME` is set
- Windows: under the current user's home directory in `.config/gamepad-websocket-server/controller-selection.json`

## Intended Use

This server is meant to be used with the browser overlay in websocket mode for OBS.

See the repo root `README.md` for the end-to-end OBS quick start, and `../overlay/README.md` for overlay URL parameters and layout/theme details.

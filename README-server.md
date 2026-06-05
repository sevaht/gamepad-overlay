# Gamepad Server

Local server for the bundled overlay.

This is the intended production input source for OBS usage.

## Requirements

For running from source:

- Python 3.11+
- `uv`
- SDL2-compatible runtime available

Platform notes:

- Windows: `uv sync` should install the required SDL2 DLL package automatically.
- Linux: you still need an SDL2-compatible runtime on the system. A normal SDL2 package works, and `sdl2-compat` should also be fine if it provides the SDL2 library that `pysdl2` loads.

## Run

Linux:

```bash
uv sync
uv run gamepad-server
```

Windows (PowerShell):

```powershell
uv sync
uv run gamepad-server
```

By default, this opens the Qt controller selector window, creates a system tray icon, and starts the server. To start in the tray with the selector window hidden, pass `--hide`. For environments without a desktop tray, run the server directly with `--headless`:

```bash
uv run gamepad-server --headless
```

## Packaged Releases

Tagged releases include portable archives for Windows and Linux. Each archive extracts to a directory with:

```text
gamepad-server
_internal/
README.md
README-server.md
README-overlay.md
```

- Run the packaged server application from the extracted directory.
- Point OBS at `http://127.0.0.1:8765/`.

This is the recommended path for users who do not want to install Python or `uv`.

The server also serves the overlay itself on the same port, so OBS does not need a separate local file path in the normal workflow.

The websocket server listens on:

- host: `localhost` by default
- port: `8765`
- path: `/gamepad-overlay`

The local overlay page is available at:

```text
http://127.0.0.1:8765/
```

The matching overlay websocket URL is:

```text
ws://localhost:8765/gamepad-overlay
```

## Useful Commands

## Selecting a Controller

The server supports both interactive and explicit controller selection.

### Interactive Selection

To list currently connected controllers and choose one interactively:

```bash
uv run gamepad-server --select-controller
```

This saves the selected controller so later normal launches will reuse it. You can also choose `0` to select "any controller", which clears the saved selection.

### Use Any Controller

To clear the saved selection and accept any connected controller:

```bash
uv run gamepad-server --any-controller
```

This removes the persisted selection so the server will accept any available controller on next launch.

If the server is already running without an explicit `--controller-guid` or `--controller-name` override, changing the saved selection will cause the running server to switch targets automatically.

### Tray Selector

The default command runs the desktop tray selector:

```bash
uv run gamepad-server
```

This launcher opens the selector window and starts the server if one is not already running. Use `--hide` to start with only the tray icon visible:

```bash
uv run gamepad-server --hide
```

The tray menu only provides:

- `Configure...` to open the selector window
- `Quit` to stop the managed server and exit

The tray is implemented with Qt via `PySide6`, which provides the same tray behavior on Linux and Windows. Closing the selector window hides it; use the tray menu's `Quit` action or the window's `Quit` button to stop the managed server and exit the tray app.

If the server is already running in its normal config-driven mode, selecting a controller in the window will update the running server automatically.

To run without tray integration:

```bash
uv run gamepad-server --headless
```

### Inspect Available Controllers

To print the currently visible controllers without selecting one:

```bash
uv run gamepad-server --list-controllers
```

### Explicit Selection by GUID

If you already know the controller GUID:

```bash
uv run gamepad-server --controller-guid <guid>
```

### Explicit Selection by Name Substring

If you want to match a controller by a case-insensitive name substring:

```bash
uv run gamepad-server --controller-name "Xbox"
```

### Persistence

Controller selection is persisted and reused on future launches. Running one of the explicit selection commands also updates the saved selection.

List controllers:

```bash
uv run gamepad-server --list-controllers
```

Interactively select and save the selected controller (choose `0` to use any):

```bash
uv run gamepad-server --select-controller
```

Clear the saved selection and use any controller:

```bash
uv run gamepad-server --any-controller
```

Select controller by GUID:

```bash
uv run gamepad-server --controller-guid <guid>
```

Select controller by name substring:

```bash
uv run gamepad-server --controller-name "Xbox"
```

Allow websocket access from other machines on the LAN:

```bash
uv run gamepad-server --lan
```

Print controller state to the terminal instead of serving websocket:

```bash
uv run gamepad-server --terminal
```

## Controller Selection Persistence

Selected controller selection is persisted to:

- Linux: `~/.config/gamepad-server/controller-selection.json` unless `XDG_CONFIG_HOME` is set
- Windows: under the current user's home directory in `.config/gamepad-server/controller-selection.json`

## Intended Use

This server is meant to be used with the browser overlay in websocket mode for OBS.

See the repo root `README.md` for the end-to-end OBS quick start, and `README-overlay.md` for overlay URL parameters and layout/theme details.

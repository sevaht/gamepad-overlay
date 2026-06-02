# Gamepad Overlay

Gamepad button and stick overlay for OBS.

This repository contains two pieces:

- `server/`: local websocket server that reads controller input
- `overlay/`: browser-based overlay UI

The intended production workflow is:

1. run the local websocket server,
2. load the overlay in an OBS Browser Source,
3. let the overlay connect to the local websocket server.

The default input source is `websocket`, which is the intended OBS workflow.

The other input sources (`demo` and `browser`) are for experimentation, previewing, and testing.

## Quick Start (OBS / Intended Workflow)

If you want to use this in OBS, start here.

### 1. Run the Local Websocket Server

Requirements:

- Python 3.11+
- `uv`
- SDL2-compatible runtime available

Platform notes:

- Windows: `uv sync` should install the required SDL2 DLL package automatically.
- Linux: you still need an SDL2-compatible runtime on the system. A normal SDL2 package works, and `sdl2-compat` should also be fine if it provides the SDL2 library that `pysdl2` loads.

Run the same commands on Linux or Windows (for example in PowerShell on Windows):

```bash
cd server
uv sync
uv run gamepad-websocket-server
```

The server listens on:

- host: `localhost` by default
- port: `8765`
- path: `/gamepad-overlay`

Optional: if you have multiple controllers connected and want to choose one up front, run:

```bash
cd server
uv run gamepad-websocket-server --select-controller
```

That saves the preferred controller for later normal launches.

The default server command opens a desktop tray selector:

```bash
cd server
uv run gamepad-websocket-server
```

The tray selector saves the preferred controller and starts the websocket server. If you need to run without tray integration, use `uv run gamepad-websocket-server --headless`.

### 2. Point OBS at the Overlay

Use a Browser Source in OBS and point it at:

```text
file:///.../overlay/index.html
```

You do not need to specify `source=websocket` unless you want to be explicit, because `websocket` is already the default source.

Example explicit URL:

```text
file:///.../overlay/index.html?source=websocket&layout=xbox&theme=xbox
```

### 3. Optional: Choose a Built-In Layout / Theme

Built-in layouts:

- `xbox`
- `xbox-digital-triggers`
- `snes`

`xbox-digital-triggers` is the main built-in derivative of the default Xbox layout. It keeps the Xbox-style geometry/theme, but changes the triggers to digital behavior so analog trigger input can be rendered as digital buttons.

Built-in themes:

- `xbox`
- `snes`

The built-in themes color the right-side face buttons to resemble the corresponding controller family.

## Windows Convenience Note

For now, `uv` is the intended easy path on Windows.

If this project later needs a more turnkey Windows distribution, the most practical next step would likely be a packaged standalone executable (for example via PyInstaller). That is not set up yet, so the current instructions use `uv`.

## Experimental / Testing Modes

These are not the intended OBS workflow, but they are useful for experimentation.

- `source=demo`
  Synthetic controller activity for previewing layouts/themes.
- `source=browser`
  Uses the browser Gamepad API directly for live testing in a normal browser.

## More Detailed Documentation

- [`overlay/README.md`](overlay/README.md)
  Overlay URL parameters, input sources, layouts, themes, and example URLs.

- [`server/README.md`](server/README.md)
  Server-focused commands, controller selection, and runtime details.

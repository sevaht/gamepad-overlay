# Gamepad Overlay

Gamepad input server plus browser-based overlay UI for OBS.

The intended workflow is:

1. run `gamepad-overlay`
2. point OBS at `http://127.0.0.1:8765/`
3. let the overlay connect back to the local server over the same port

The default input source is `websocket`, which is the intended OBS workflow.
The other input sources (`demo` and `browser`) are for experimentation,
previewing, and testing.

## Quick Start

Requirements for running from source:

- Python 3.12+
- `uv`
- SDL2-compatible runtime available

Platform notes:

- Windows: `uv sync` should install the required SDL2 DLL package automatically.
- Linux: you still need an SDL2-compatible runtime on the system. A normal SDL2 package works, and `sdl2-compat` should also be fine if it provides the SDL2 library that `pysdl2` loads.

Run:

```bash
uv sync
uv run gamepad-overlay
```

By default, this opens the Qt selector window, creates a tray icon, and starts
the local server.

To point OBS at the overlay, use a Browser Source with:

```text
http://127.0.0.1:8765/
```

You do not need to specify `source=websocket` unless you want to be explicit.

Example explicit URL:

```text
http://127.0.0.1:8765/?source=websocket&layout=xbox&theme=xbox
```

The local server listens on:

- host: `localhost` by default
- port: `8765`
- websocket path: `/gamepad-overlay`

## Packaged Releases

Tagged releases include portable archives for Windows and Linux. Each archive
extracts to a directory shaped like:

```text
gamepad-overlay-<tag>-<platform>/
  gamepad-overlay
  _internal/
  README.md
```

Run the packaged app from the extracted directory. It serves the overlay itself
at `http://127.0.0.1:8765/`.

## Controller Selection

The server supports both interactive and explicit controller selection.

Interactively select a connected controller:

```bash
uv run gamepad-overlay --select-controller
```

Choose `0` in that selector to use any controller.

Clear the saved controller selection explicitly:

```bash
uv run gamepad-overlay --any-controller
```

Select controller by GUID:

```bash
uv run gamepad-overlay --controller-guid <guid>
```

Select controller by case-insensitive name substring:

```bash
uv run gamepad-overlay --controller-name "Xbox"
```

Additional useful commands:

```bash
uv run gamepad-overlay --hide
uv run gamepad-overlay --headless
uv run gamepad-overlay --list-controllers
uv run gamepad-overlay --lan
uv run gamepad-overlay --terminal
```

Selected controller config is persisted to:

- Linux: `~/.config/gamepad-overlay/controller-selection.json` unless `XDG_CONFIG_HOME` is set
- Windows: under the current user's home directory in `.config/gamepad-overlay/controller-selection.json`

## Overlay Parameters

### Overlay / Display

- `theme=<name>`
  Loads `overlay-theme-<name>.css`.
  If omitted, the selected layout can provide a default theme. Otherwise it falls back to `xbox`.

- `layout=<name>`
  Loads `overlay-layout-<name>.js`.
  If omitted, defaults to `xbox`.

- `background=<css-color-or-css-background-value>`
  Sets `document.body.style.background`.

- `stretch=1`
  Disables aspect-ratio preservation and stretches the overlay to fill the available area.

- `blur=<number>`
  Overrides the default SVG blur / anti-aliasing amount.
  If omitted, the default comes from the theme if it defines one, otherwise from the layout if it defines one, otherwise from the built-in app fallback.

### Input Source Selection

- `source=websocket|browser|demo`
  If omitted, the default is `websocket`.

### Websocket Source

- When served from `http://` or `https://`, the overlay connects back to the same origin at `/gamepad-overlay`.
- When loaded from `file://`, it connects to `ws://localhost:8765/gamepad-overlay`.
- `wsHost=<hostname-or-ip>` overrides the host if needed.

### Browser Source

- `padIndex=<number>`
  Controller index hint. Useful for debugging/testing, but not as stable as ID matching.

- `padIdContains=<substring>`
  Preferred browser-controller selector.

- `padAllowAll=1`
  Allows non-standard-mapped browser controllers.

- `pollHz=<number>`
  Browser polling frequency. Defaults to `240`.

### Input Behavior

- `digitalThreshold=<0..1>`
  Defaults to `0.2` unless a layout overrides it.

## Layouts and Themes

Layouts and themes are separate.

- A layout controls geometry and behavior.
- A theme controls colors and rendering finish.

Built-in layouts:

- `xbox`
- `xbox-digital-triggers`
- `snes`

Built-in themes:

- `xbox`
- `snes`

Themes can define:

- button and analog colors
- border colors
- optional default blur via `--overlay-default-blur`

Layouts can define:

- default theme
- optional default blur
- button dimensions
- border sizes
- analog-stick presence
- trigger modes (`analog`, `digital`, `none`)
- ring sizing values
- default digital threshold

## Example URLs

Demo preview:

```text
http://127.0.0.1:8765/?source=demo&layout=snes&theme=snes
```

Browser API testing:

```text
http://127.0.0.1:8765/?source=browser&layout=xbox&theme=xbox
```

Digital trigger layout preview:

```text
http://127.0.0.1:8765/?layout=xbox-digital-triggers&source=demo
```

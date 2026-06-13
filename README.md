# Gamepad Overlay

Shows your gamepad inputs as a visual overlay in OBS (or any tool that supports browser sources).

The app runs in your system tray, reads your controller, and serves an overlay page your streaming software can display.

---

## Installation

Download the latest release for your platform from the Releases page and extract the archive. No installer needed — just run the executable inside.

**Windows:** `gamepad-overlay.exe`  
**Linux:** `gamepad-overlay`

---

## Getting Started

1. **Run the app.** A window opens showing your connected gamepads and a tray icon appears.
2. **Select your controller.** Click the gamepad you want to use, then click **Save Selection**. If you only have one controller or don't care which one is used, leave it on *Any available gamepad*.
3. **Open OBS** and add a **Browser Source**.
4. **Get the URL.** In the gamepad overlay window, click **Overlay URL**. Copy the URL shown and paste it into your OBS browser source.
5. **Done.** The overlay will display your controller inputs in your stream or recording.

---

## Gamepad Selection

The main window lists all connected gamepads. Select one and click **Save Selection** to lock in that controller.

When you select a gamepad you can choose how it's matched:

- **Identity** — matches by hardware ID (GUID, vendor, product). The controller will be recognized regardless of which USB port it's plugged into.
- **Physical Port** — matches by the specific USB port. Useful if you want to always use whichever controller is plugged into a particular port.
- **Both** — requires both identity and port to match.

If you select *Any available gamepad*, the overlay uses whatever controller is connected at the time.

---

## Overlay URL Window

Open this from the main window with the **Overlay URL** button. It shows the full URL to paste into OBS and lets you configure the overlay appearance.

### Overlay Settings

| Setting | Description |
|---|---|
| **Source** | `websocket` (normal use) or `demo` (animated preview, no controller needed) |
| **Layout** | Controller shape — `xbox`, `xbox-digital-triggers`, or `snes` |
| **Theme** | Color scheme — `Auto` (follows layout default), `xbox`, or `snes` |
| **Background** | Any CSS color or background value (e.g. `green`, `#00ff00`, `transparent`). Leave blank for the layout default. |
| **Blur** | Anti-aliasing/blur amount. `0` disables it. |
| **Digital Threshold %** | How far an analog trigger must be pressed before it registers as a digital press. Default is 20%. |

Changes to overlay settings take effect immediately and are saved automatically.

### Server Settings

| Setting | Description |
|---|---|
| **Server Port** | The port the local server listens on. Default is `8765`. Change this if something else on your machine is using that port. |

After changing the port, click **Apply Server Settings**. The server restarts on the new port and the URL updates to match. Update your OBS browser source with the new URL.

**Reset to Defaults** restores all overlay settings and the server port to their original values.

---

## Layouts and Themes

Layouts control the shape and behavior of the controller display. Themes control colors and visual style. They are independent — any theme can be combined with any layout.

**Built-in layouts:**
- `xbox` — standard Xbox controller with analog triggers
- `xbox-digital-triggers` — Xbox controller with triggers shown as digital buttons
- `snes` — SNES-style controller (no analog sticks or triggers)

**Built-in themes:**
- `xbox` — dark Xbox color scheme
- `snes` — SNES color scheme

---

## Troubleshooting

**The overlay isn't showing any input.**  
Make sure the app is running and the correct gamepad is selected. Check that the URL in your OBS browser source matches what the Overlay URL window shows.

**The overlay won't connect to the server.**  
Try the URL with `127.0.0.1` instead of `localhost`. Some systems resolve these differently.

**I want to test the overlay without a controller.**  
Set **Source** to `demo` in the Overlay URL window. The overlay will cycle through animations so you can preview it.

**Something else is using port 8765.**  
Open the Overlay URL window, go to **Server Settings**, change the port, and click **Apply Server Settings**. Update your OBS browser source with the new URL.

---

## OBS Browser Source Tips

- Set the browser source resolution to match the area you want the overlay to occupy (e.g. 1920×1080 for full screen, or a smaller size for a corner overlay).
- The overlay scales to fill its browser source. Use OBS transform controls to position and resize it on your canvas.
- Enable **Shutdown source when not visible** if you want the overlay to disconnect when the scene isn't active.

---

## Advanced / CLI

The app can also be controlled from the command line.

**List connected gamepads:**
```
gamepad-overlay --list-gamepads
```

**Select gamepad by name:**
```
gamepad-overlay --gamepad-name "Xbox"
```

**Select gamepad by GUID:**
```
gamepad-overlay --gamepad-guid <guid>
```

**Use any gamepad:**
```
gamepad-overlay --any-gamepad
```

**Set the server port:**
```
gamepad-overlay --port 9000
```

**Start with the window hidden:**
```
gamepad-overlay --hide
```

**Run without a system tray (headless):**
```
gamepad-overlay --headless
```

---

## Running from Source

Requires Python 3.12+ and [`uv`](https://docs.astral.sh/uv/).

```bash
uv sync
uv run gamepad-overlay
```

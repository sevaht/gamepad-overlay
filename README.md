# Gamepad Overlay

Shows your gamepad inputs as a visual overlay in OBS (or any tool that supports browser sources).

The app runs in your system tray, reads your controller, and serves an overlay page your streaming software can display. The overlay has a transparent background, so it sits cleanly on top of your gameplay.

**What you need:**
- A game controller (Xbox, SNES-style, or any standard gamepad).
- OBS Studio, or any streaming/recording tool that supports a **Browser Source**.

---

## Installation

Download the latest release for your platform from the Releases page and extract the archive. No installer needed — just run the executable inside.

**Windows:** `gamepad-overlay.exe`  
**Linux:** `gamepad-overlay`

---

## Getting Started

1. **Run the app.** A window opens showing your connected gamepads, and a tray icon appears.
2. **Pick your controller.** In the list, click the controller you want, then click **Select Gamepad**. If you only have one controller, or you don't care which one is used, click **Any Gamepad** instead.
3. **Open OBS** and add a **Browser Source**.
4. **Get the URL.** In the gamepad overlay window, click **Overlay URL...**, then click **Copy** to copy the address. Paste it into your OBS browser source.
5. **Done.** The overlay will display your controller inputs in your stream or recording.

---

## Gamepad Selection

The main window lists all connected gamepads. Click one, decide how it should be matched using the **Criteria** checkboxes, then click **Select Gamepad**. To go back to using whatever controller is connected, click **Any Gamepad**.

The **Criteria** checkboxes control how your controller is recognized the next time it's connected:

- **Identity** — match by hardware ID (vendor/product, or GUID). The controller is recognized no matter which USB port it's plugged into.
- **Physical port** — match by the specific USB port. Useful when you always want whichever controller is plugged into a particular port.
- Tick **both** to require the same controller *and* the same port.

The controller currently in use is marked with a ★ in the list, and the **Target:** line at the top of the window always shows what the overlay is set to use.

---

## Overlay URL Window

Open this from the main window with the **Overlay URL...** button. It shows the full URL to paste into OBS and lets you configure the overlay appearance. Use **Copy** to copy the URL, or **Launch in Browser** to preview the overlay.

### Overlay Settings

| Setting | Description |
|---|---|
| **Source** | `websocket` (normal use) or `demo` (animated preview that plays without a controller, handy for testing) |
| **Layout** | Controller shape — `xbox`, `xbox-digital-triggers`, or `snes` |
| **Theme** | Color scheme — `Auto` (follows the layout's default), `xbox`, or `snes` |
| **Background** | The overlay background. Leave blank to keep it transparent (recommended for streaming). Accepts any CSS color, e.g. `green`, `#00ff00`, or `transparent`. |
| **Blur** | Softens the overlay's edges (anti-aliasing). Set to `0` for crisp, hard edges. |
| **Digital Threshold %** | How far an analog trigger must be pressed before it counts as "pressed." Default is 20%. |

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

> Everything below is for advanced users. If you're just using the app normally, you can stop here.

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

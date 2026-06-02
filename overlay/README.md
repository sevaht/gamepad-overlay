# Overlay

Browser-based controller overlay UI.

Main entrypoint:

- `overlay/index.html`

The intended production input source is `websocket`.

Other input sources (`demo` and `browser`) are for experimentation, previewing, and testing.

## Input Sources

### `source=websocket`

Default source, and the intended OBS mode.

- Connects to `ws://<wsHost>:8765/gamepad-overlay`
- `wsHost` defaults to `localhost`
- Expects the local websocket server from `../server/` to be running

### `source=demo`

Preview/demo mode.

- No real controller needed
- Generates synthetic controller activity
- Useful for testing layout/theme appearance

### `source=browser`

Experimental/testing mode.

- Uses the browser Gamepad API directly
- Useful for testing live controller behavior in a regular browser
- Not the intended OBS workflow
- Logs discovered browser controllers to the console when the set of connected controllers changes

#### Selecting a Controller in `source=browser`

When using `source=browser`, the overlay will log the set of detected browser controllers to the browser console whenever that set changes.

Recommended selector:

- use `padIdContains=<substring>`

This is the preferred selector because browser controller indexes are less stable than controller IDs.

Example:

```text
overlay/index.html?source=browser&padIdContains=8BitDo
```

You can also provide:

- `padIndex=<number>`

but this should be treated as a hint for testing/debugging, not as a durable identity.

If you want to allow non-standard browser mappings, add:

```text
padAllowAll=1
```

There is currently no separate GUI selector for `source=browser`; browser-mode selection is controlled by the URL parameters above.

## GET Parameters

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
  If omitted, the overlay preserves aspect ratio without cropping.

### Input Source Selection

- `source=websocket|browser|demo`
  If omitted, the default is `websocket`.

### Websocket Source

- `wsHost=<hostname-or-ip>`
  Websocket host. Defaults to `localhost`.

### Browser Source

- `padIndex=<number>`
  Controller index hint. Useful for debugging/testing, but not as stable as ID matching.

- `padIdContains=<substring>`
  Preferred browser-controller selector. Case-insensitive contiguous substring match against the browser-reported controller ID.

- `padAllowAll=1`
  Allows non-standard-mapped browser controllers.
  If omitted, standard-mapped controllers are preferred/required.

- `pollHz=<number>`
  Browser polling frequency. Defaults to `240`.
  This is only meaningful for `source=browser`.

### Input Behavior

- `digitalThreshold=<0..1>`
  Threshold used for digital-style controls that are fed analog values.
  Defaults to `0.2` unless a layout overrides it.

## Layouts and Themes

Layouts and themes are separate.

- A layout controls geometry and behavior.
- A theme controls colors.

You can mix them freely, although some combinations are more natural than others.

Built-in layouts:

- `xbox`
- `xbox-digital-triggers`
- `snes`

`xbox-digital-triggers` is the main built-in derivative of the default Xbox layout. It keeps the Xbox-style geometry/theme, but changes the triggers to digital behavior so analog trigger input can be rendered as digital buttons.

Built-in themes:

- `xbox`
- `snes`

The built-in themes color the right-side face buttons to resemble the corresponding controller family.

### Themes

Themes are CSS files named like:

- `overlay-theme-xbox.css`
- `overlay-theme-snes.css`

Custom theme names work too:

- `theme=my-theme` -> `overlay-theme-my-theme.css`

Theme names are sanitized to allow only:

- `a-z`
- `0-9`
- `_`
- `-`

### Layouts

Layouts are JS files named like:

- `overlay-layout-xbox.js`
- `overlay-layout-xbox-digital-triggers.js`
- `overlay-layout-snes.js`

Custom layout names work too:

- `layout=my-layout` -> `overlay-layout-my-layout.js`

Layouts can define:

- default theme
- button dimensions
- border sizes
- analog-stick presence
- trigger modes (`analog`, `digital`, `none`)
- ring sizing values
- default digital threshold

## Example URLs

Demo preview:

```text
overlay/index.html?source=demo&layout=snes&theme=snes
```

Browser API testing:

```text
overlay/index.html?source=browser&layout=xbox&theme=xbox
```

Digital trigger layout preview:

```text
overlay/index.html?layout=xbox-digital-triggers&source=demo
```

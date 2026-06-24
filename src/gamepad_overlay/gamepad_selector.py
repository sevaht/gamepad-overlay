"""The tkinter gamepad-selector window and its supporting helpers."""

from __future__ import annotations

import contextlib
import logging
import tkinter as tk
import webbrowser
from dataclasses import dataclass, field
from threading import Thread
from tkinter import ttk
from typing import TYPE_CHECKING, ClassVar, Protocol
from urllib.parse import urlencode

from sevaht_gui import LabelGrooveFrame

from .config import read_section, update_section
from .gamepad import (
    GamepadInfo,
    GamepadSelection,
    SDLGamepad,
    port_display_name,
)
from .server import (
    DEFAULT_PORT,
    MAX_PORT,
    MIN_PORT,
    load_server_port,
    save_server_port,
)
from .tray_render import _create_face_buttons_image

if TYPE_CHECKING:
    from collections.abc import Callable
    from pathlib import Path

    from sevaht_gui import TkApp

logger = logging.getLogger(__name__)


class ServerBackend(Protocol):
    def ensure_started(self) -> None: ...

    def is_gamepad_connected(self) -> bool: ...

    def client_count(self) -> int: ...

    def active_gamepad(self) -> GamepadInfo | None: ...

    def stop(self) -> None: ...

    def restart(self, new_port: int) -> None: ...


APP_TITLE = "Gamepad Overlay"


def _status_detail(*, attached: bool, client_count: int) -> str:
    state = "Attached" if attached else "Detached"
    client_label = "Client" if client_count == 1 else "Clients"
    return f"{state} ({client_count} {client_label} Connected)"


def _status_text(*, attached: bool, client_count: int) -> str:
    """Single-line status for the window title bar."""
    detail = _status_detail(attached=attached, client_count=client_count)
    return f"{APP_TITLE} - {detail}"


def _status_tooltip(*, attached: bool, client_count: int) -> str:
    """Multiline status for the tray tooltip: title line then the detail."""
    detail = _status_detail(attached=attached, client_count=client_count)
    return f"{APP_TITLE}\n{detail}"


def _gamepad_display_names(gamepads: list[GamepadInfo]) -> list[str]:
    names = [gamepad.name for gamepad in gamepads]
    duplicates = {name for name in names if names.count(name) > 1}
    if not duplicates:
        return names

    duplicate_counts: dict[str, int] = {}
    display_names: list[str] = []
    for name in names:
        if name not in duplicates:
            display_names.append(name)
            continue
        duplicate_counts[name] = duplicate_counts.get(name, 0) + 1
        display_names.append(f"{name} [{duplicate_counts[name]}]")
    return display_names


def _selected_gamepad_index(
    gamepads: list[GamepadInfo], selected: GamepadSelection | None
) -> int | None:
    if selected is None:
        return None
    for index, gamepad in enumerate(gamepads):
        if selected.matches(gamepad):
            return index
    return None


def _mode_texts(selected: GamepadSelection | None) -> tuple[str, str]:
    """Return (name_line, detail_line) for the mode bar (no prefix — caller adds 'Target:')."""
    if selected is None or selected.is_any():
        return ("Any available gamepad", "")
    has_identity = bool(selected.guid or selected.vendor or selected.product)
    name = selected.name or "Unknown gamepad"
    main = name if has_identity else "Any gamepad"
    detail = selected.metadata_summary()
    return (main, detail)


def _list_available_gamepads() -> list[GamepadInfo]:
    return SDLGamepad.list_available_gamepads()


def _clear_entry_selections(widget: tk.Misc) -> None:
    if isinstance(widget, tk.Entry):
        with contextlib.suppress(tk.TclError):
            widget.selection_clear()
    for child in widget.winfo_children():
        _clear_entry_selections(child)


def _safe_float(text: str, default: float) -> float:
    try:
        return float(text)
    except ValueError:
        return default


@dataclass
class GamepadSelectorConfig:
    hide_on_close: bool
    selection_changed_callback: Callable[[], None] | None = field(default=None)


class OverlayUrlWindow:
    """Toplevel for viewing and configuring the overlay URL.

    Created on demand and destroyed on close (settings persist to config, so a
    fresh instance restores the same state); ``on_close`` notifies the owner so
    it can drop its reference.
    """

    _DEFAULTS: ClassVar[dict[str, object]] = {
        "source": "websocket",
        "layout": "xbox",
        "theme": "Auto",
        "background": "",
        "blur": "0.5",
        "digitalThreshold": "20",
    }

    def __init__(
        self,
        app: TkApp,
        config_path: Path,
        server_backend: ServerBackend | None = None,
        on_close: Callable[[], None] | None = None,
    ) -> None:
        self._config_path = config_path
        self._server_backend = server_backend
        self._on_close = on_close
        self._apply_button: ttk.Button | None = None
        self._applied_port: int = load_server_port(self._config_path)
        self._window = tk.Toplevel(app.root)
        self._window.title("Gamepad Overlay URL")
        self._window.resizable(False, False)
        self._window.transient(app.root)
        self._window.protocol("WM_DELETE_WINDOW", self._close)
        # Build the window hidden so it does not flash at its initial tiny size
        # while widgets are laid out; show_and_raise reveals it once sized.
        self._window.withdraw()
        # Mirror the main window's (connection-state) icon, live.
        app.track_window_icon(self._window)

        window = self._window
        self._source_var = tk.StringVar(master=window)
        self._layout_var = tk.StringVar(master=window)
        self._theme_var = tk.StringVar(master=window)
        self._background_var = tk.StringVar(master=window)
        self._blur_var = tk.StringVar(master=window)
        self._digital_threshold_var = tk.StringVar(master=window)
        self._port_var = tk.StringVar(master=window)
        self._url_var = tk.StringVar(master=window)

        self._apply_defaults()
        self._load_config()
        self._port_var.set(str(self._applied_port))

        for var in (
            self._source_var,
            self._layout_var,
            self._theme_var,
            self._background_var,
            self._blur_var,
            self._digital_threshold_var,
        ):
            var.trace_add("write", self._on_var_changed)
        self._port_var.trace_add("write", self._on_port_var_changed)

        self._build_widgets()
        self._update_url()

    def _apply_defaults(self) -> None:
        defaults = self._DEFAULTS
        self._source_var.set(str(defaults["source"]))
        self._layout_var.set(str(defaults["layout"]))
        self._theme_var.set(str(defaults["theme"]))
        self._background_var.set(str(defaults["background"]))
        self._blur_var.set(str(defaults["blur"]))
        self._digital_threshold_var.set(str(defaults["digitalThreshold"]))

    def _load_config(self) -> None:
        overlay_data = read_section(self._config_path, "overlay")
        for key, variable in (
            ("source", self._source_var),
            ("layout", self._layout_var),
            ("theme", self._theme_var),
            ("background", self._background_var),
            ("blur", self._blur_var),
        ):
            value = overlay_data.get(key)
            if isinstance(value, str):
                variable.set(value)
        threshold = overlay_data.get("digitalThreshold")
        if isinstance(threshold, str):
            self._digital_threshold_var.set(
                self._normalize_threshold_text(threshold)
            )

    def _normalize_threshold_text(self, threshold_text: str) -> str:
        """Convert a legacy 0..1 fractional threshold to a 1..100 percentage."""
        try:
            threshold_value = float(threshold_text)
        except ValueError:
            return str(self._DEFAULTS["digitalThreshold"])
        if threshold_value < 1.0:
            return str(round(threshold_value * 100))
        return threshold_text

    def _save_config(self) -> None:
        update_section(
            self._config_path,
            "overlay",
            {
                "source": self._source_var.get(),
                "layout": self._layout_var.get(),
                "theme": self._theme_var.get(),
                "background": self._background_var.get(),
                "blur": self._blur_var.get(),
                "digitalThreshold": self._digital_threshold_var.get(),
            },
        )

    def _build_widgets(self) -> None:
        outer = ttk.Frame(self._window, padding=14)
        outer.pack(fill=tk.BOTH, expand=True)

        url_frame = LabelGrooveFrame(outer, text="Overlay URL")
        url_frame.pack(fill=tk.X, padx=4, pady=4)
        url_entry = ttk.Entry(
            url_frame.interior,
            textvariable=self._url_var,
            state="readonly",
            width=60,
        )
        url_entry.pack(fill=tk.X, padx=6, pady=(0, 2))
        btn_frame = ttk.Frame(url_frame.interior)
        btn_frame.pack(anchor="w", padx=6)
        ttk.Button(btn_frame, text="Copy", command=self._copy_url).pack(
            side=tk.LEFT, padx=(0, 6)
        )
        ttk.Button(
            btn_frame, text="Launch in Browser", command=self._launch_browser
        ).pack(side=tk.LEFT)

        options_frame = LabelGrooveFrame(outer, text="Overlay Settings")
        options_frame.pack(fill=tk.X, padx=4, pady=4)
        options_frame.interior.columnconfigure(1, weight=1)

        inner = options_frame.interior
        overlay_rows: list[tuple[str, tk.Widget]] = [
            (
                "Source",
                ttk.Combobox(
                    inner,
                    textvariable=self._source_var,
                    values=["websocket", "demo"],
                    state="readonly",
                    width=22,
                ),
            ),
            (
                "Layout",
                ttk.Combobox(
                    inner,
                    textvariable=self._layout_var,
                    values=["xbox", "xbox-digital-triggers", "snes"],
                    state="readonly",
                    width=22,
                ),
            ),
            (
                "Theme",
                ttk.Combobox(
                    inner,
                    textvariable=self._theme_var,
                    values=["Auto", "xbox", "snes"],
                    state="readonly",
                    width=22,
                ),
            ),
            (
                "Background",
                ttk.Entry(inner, textvariable=self._background_var),
            ),
            (
                "Blur",
                ttk.Spinbox(
                    inner,
                    textvariable=self._blur_var,
                    from_=0.0,
                    to=20.0,
                    increment=0.5,
                    format="%.1f",
                    width=8,
                ),
            ),
            (
                "Digital Threshold %",
                ttk.Spinbox(
                    inner,
                    textvariable=self._digital_threshold_var,
                    from_=1,
                    to=100,
                    increment=1,
                    width=8,
                ),
            ),
        ]
        last_row_idx = len(overlay_rows) - 1
        for row_idx, (label, widget) in enumerate(overlay_rows):
            top_pad = 0 if row_idx == 0 else 3
            bot_pad = 0 if row_idx == last_row_idx else 3
            ttk.Label(options_frame.interior, text=label).grid(
                row=row_idx,
                column=0,
                sticky="w",
                padx=(6, 8),
                pady=(top_pad, bot_pad),
            )
            widget.grid(
                row=row_idx,
                column=1,
                sticky="ew",
                padx=(0, 6),
                pady=(top_pad, bot_pad),
            )

        server_frame = LabelGrooveFrame(outer, text="Server Settings")
        server_frame.pack(fill=tk.X, padx=4, pady=4)
        server_frame.interior.columnconfigure(1, weight=1)
        ttk.Label(server_frame.interior, text="Server Port").grid(
            row=0, column=0, sticky="w", padx=(6, 8), pady=3
        )
        ttk.Spinbox(
            server_frame.interior,
            textvariable=self._port_var,
            from_=MIN_PORT,
            to=MAX_PORT,
            increment=1,
            width=8,
        ).grid(row=0, column=1, sticky="ew", padx=(0, 6), pady=3)
        if self._server_backend is not None:
            self._apply_button = ttk.Button(
                server_frame.interior,
                text="Apply Server Settings",
                command=self._apply_server_settings,
                state="disabled",
            )
            self._apply_button.grid(
                row=1, column=0, columnspan=2, sticky="w", padx=6, pady=(2, 6)
            )

        reset_frame = ttk.Frame(outer)
        reset_frame.pack(fill=tk.X, padx=4, pady=(8, 4))
        ttk.Button(reset_frame, text="Close", command=self._close).pack(
            side=tk.RIGHT
        )
        ttk.Button(
            reset_frame,
            text="Reset to Defaults",
            command=self._reset_to_defaults,
        ).pack(side=tk.RIGHT, padx=(0, 6))

    def _build_url(self) -> str:
        base = f"http://localhost:{self._applied_port}/"
        params: dict[str, str] = {}

        source = self._source_var.get()
        layout = self._layout_var.get()
        theme = self._theme_var.get()

        if source != "websocket":
            params["source"] = source
        if layout != "xbox":
            params["layout"] = layout

        # "Auto" means omit; any explicit selection is always included so the
        # URL faithfully reflects what the user chose.
        if theme != "Auto":
            params["theme"] = theme

        background = self._background_var.get().strip()
        if background:
            params["background"] = background

        blur_text = self._blur_var.get().strip()
        default_blur = float(str(self._DEFAULTS["blur"]))
        blur = max(0.0, min(20.0, _safe_float(blur_text, default_blur)))
        if blur != default_blur:
            params["blur"] = f"{blur:.10g}"

        threshold_text = self._digital_threshold_var.get().strip()
        default_threshold = int(str(self._DEFAULTS["digitalThreshold"]))
        threshold_percent = max(
            1,
            min(
                100, int(_safe_float(threshold_text, float(default_threshold)))
            ),
        )
        if threshold_percent != default_threshold:
            params["digitalThreshold"] = str(threshold_percent)

        if params:
            return base + "?" + urlencode(params)
        return base

    def _on_var_changed(self, *_: object) -> None:
        self._update_url()
        self._save_config()

    def _on_port_var_changed(self, *_: object) -> None:
        try:
            port = int(self._port_var.get())
            if MIN_PORT <= port <= MAX_PORT:
                save_server_port(port, self._config_path)
        except ValueError:
            pass
        self._update_apply_button_state()

    def _update_apply_button_state(self) -> None:
        if self._apply_button is None or self._server_backend is None:
            return
        try:
            port = int(self._port_var.get())
            valid = MIN_PORT <= port <= MAX_PORT
        except ValueError:
            valid = False
        if valid and port != self._applied_port:
            self._apply_button.state(["!disabled"])
        else:
            self._apply_button.state(["disabled"])

    def _apply_server_settings(self) -> None:
        if self._server_backend is None or self._apply_button is None:
            return
        try:
            port = int(self._port_var.get())
        except ValueError:
            return
        if not (MIN_PORT <= port <= MAX_PORT):
            return
        self._applied_port = port
        self._update_url()
        self._apply_button.state(["disabled"])
        Thread(
            target=self._server_backend.restart, args=(port,), daemon=True
        ).start()

    def _update_url(self, *_: object) -> None:
        self._url_var.set(self._build_url())

    def _reset_to_defaults(self) -> None:
        self._apply_defaults()
        self._applied_port = DEFAULT_PORT
        self._port_var.set(str(DEFAULT_PORT))
        save_server_port(DEFAULT_PORT, self._config_path)
        self._update_url()
        self._update_apply_button_state()
        if self._server_backend is not None:
            Thread(
                target=self._server_backend.restart,
                args=(DEFAULT_PORT,),
                daemon=True,
            ).start()

    def _copy_url(self) -> None:
        self._window.clipboard_clear()
        self._window.clipboard_append(self._url_var.get())
        self._window.update()

    def _launch_browser(self) -> None:
        webbrowser.open(self._url_var.get())

    def _close(self) -> None:
        self._window.destroy()
        if self._on_close is not None:
            self._on_close()

    def show_and_raise(self) -> None:
        self._port_var.set(str(self._applied_port))
        self._update_apply_button_state()
        # Compute the layout while still hidden so it appears at full size and
        # the WM positions it (relative to the parent) correctly.
        self._window.update_idletasks()
        self._window.deiconify()
        self._window.lift()
        self._window.focus_force()
        _clear_entry_selections(self._window)


class GamepadSelectorWindow:
    def __init__(
        self,
        app: TkApp,
        config_path: Path,
        window_config: GamepadSelectorConfig,
        *,
        server_backend: ServerBackend | None = None,
    ) -> None:
        self.app = app
        self.root = app.root
        self.config_path = config_path
        self.server_backend = server_backend
        self.hide_on_close = window_config.hide_on_close
        self.selection_changed_callback = (
            window_config.selection_changed_callback
        )
        self.gamepads: list[GamepadInfo] = []
        self._saved_selection: GamepadSelection | None = None
        self._window_icon_connected: bool | None = None
        self._overlay_url_window: OverlayUrlWindow | None = None
        self._build_ui()
        self._reload()
        # Start hidden; the tray decides when (and whether) to show the window.
        self.root.withdraw()

    def _build_ui(self) -> None:  # noqa: PLR0915
        # Theme and the window-close protocol are handled by TkApp.
        self.root.geometry("750x500")
        self.root.minsize(750, 420)

        content = ttk.Frame(self.root, padding=18)
        content.pack(fill=tk.BOTH, expand=True)
        content.columnconfigure(0, weight=1)
        # row 0=mode bar, row 1=list (expands), row 2=criteria, row 3=buttons
        content.rowconfigure(1, weight=1)

        # Row 0: Target indicator — "Target:" prefix | name (row 0) / detail (row 1)
        mode_frame = ttk.Frame(content)
        mode_frame.grid(row=0, column=0, sticky="ew", pady=(0, 8))
        mode_frame.columnconfigure(1, weight=1)
        ttk.Label(
            mode_frame, text="Target:", font=("TkDefaultFont", 0, "bold")
        ).grid(row=0, column=0, sticky="nw", padx=(0, 8))
        self.mode_label = ttk.Label(
            mode_frame,
            text="Any available gamepad",
            font=("TkDefaultFont", 0, "bold"),
        )
        self.mode_label.grid(row=0, column=1, sticky="w")
        self.mode_detail_label = ttk.Label(mode_frame, text="")
        self.mode_detail_label.grid(row=1, column=1, sticky="w")

        # Row 1: Gamepad list
        list_frame = ttk.Frame(content)
        list_frame.grid(row=1, column=0, sticky="nsew")
        list_frame.columnconfigure(0, weight=1)
        list_frame.rowconfigure(0, weight=1)

        self.gamepad_list = ttk.Treeview(
            list_frame,
            columns=("name", "identity", "port"),
            show="headings",
            selectmode="browse",
        )
        self.gamepad_list.heading("name", text="Gamepad")
        self.gamepad_list.heading("identity", text="Identity")
        self.gamepad_list.heading("port", text="Physical Port")
        initial_list_width = 700
        column_proportions = (0.41, 0.26, 0.33)
        for column_name, proportion in zip(
            ("name", "identity", "port"), column_proportions, strict=True
        ):
            self.gamepad_list.column(
                column_name,
                width=int(initial_list_width * proportion),
                anchor=tk.W,
            )
        self.gamepad_list.tag_configure("active", foreground="#2e7d32")
        self.gamepad_list.tag_configure("pinned", foreground="#1565c0")
        self.gamepad_list.tag_configure(
            "active_pinned", foreground="#2e7d32", background="#e3f2fd"
        )
        self.gamepad_list.grid(row=0, column=0, sticky="nsew")
        self.gamepad_list.bind(
            "<<TreeviewSelect>>",
            lambda _event: self._update_select_button_state(),
        )
        self.gamepad_list.bind(
            "<Double-1>", lambda _event: self.select_current_gamepad()
        )
        self.gamepad_list.bind("<Configure>", self._on_gamepad_list_resize)

        scrollbar = ttk.Scrollbar(
            list_frame, orient=tk.VERTICAL, command=self.gamepad_list.yview
        )
        scrollbar.grid(row=0, column=1, sticky="ns")
        self.gamepad_list.configure(yscrollcommand=scrollbar.set)

        # Row 2: Criteria LabelFrame (left) + other buttons (right), all in one row
        self.pin_identity_var = tk.BooleanVar(value=True)
        self.pin_port_var = tk.BooleanVar(value=False)

        bottom_row = ttk.Frame(content)
        bottom_row.grid(row=2, column=0, sticky="ew", pady=(8, 0))

        criteria_box = LabelGrooveFrame(bottom_row, text="Criteria")
        criteria_box.pack(side=tk.LEFT, anchor="sw")

        left_frame = ttk.Frame(criteria_box.interior)
        left_frame.grid(row=0, column=0, sticky="nsw", padx=(6, 0))

        ttk.Checkbutton(
            left_frame, text="Identity", variable=self.pin_identity_var
        ).pack(anchor="w")
        ttk.Checkbutton(
            left_frame, text="Physical port", variable=self.pin_port_var
        ).pack(anchor="w")
        self.select_button = ttk.Button(
            left_frame,
            text="Select Gamepad",
            command=self.select_current_gamepad,
        )
        self.select_button.pack(anchor="w", pady=(4, 0))

        self.pin_identity_var.trace_add(
            "write", lambda *_: self._update_select_button_state()
        )
        self.pin_port_var.trace_add(
            "write", lambda *_: self._update_select_button_state()
        )

        ttk.Separator(criteria_box.interior, orient=tk.VERTICAL).grid(
            row=0, column=1, sticky="nsew", padx=10
        )

        self.any_button = ttk.Button(
            criteria_box.interior,
            text="Any Gamepad",
            command=self.use_any_gamepad,
        )
        self.any_button.grid(row=0, column=2, sticky="sw", padx=(0, 6))

        # Right side: Overlay URL button above Quit/Hide buttons
        right_frame = ttk.Frame(bottom_row)
        right_frame.pack(side=tk.RIGHT, anchor="s")

        ttk.Button(
            right_frame,
            text="Overlay URL...",
            command=self._open_overlay_url_window,
        ).pack(fill=tk.X, pady=(0, 4))

        dismiss_frame = ttk.Frame(right_frame)
        dismiss_frame.pack(fill=tk.X)

        # The window-close (X) button is handled by TkApp: it hides when a tray
        # houses the window and quits (with confirmation) otherwise.
        if self.hide_on_close:
            ttk.Button(dismiss_frame, text="Hide", command=self.app.hide).pack(
                side=tk.RIGHT
            )

        ttk.Button(dismiss_frame, text="Quit", command=self.app.quit).pack(
            side=tk.RIGHT, padx=(0, 6) if self.hide_on_close else (0, 0)
        )

    def _open_overlay_url_window(self) -> None:
        # Create on demand and destroy on close (settings persist to config, so
        # nothing is lost); the guard just avoids opening a second copy.
        if self._overlay_url_window is None:
            self._overlay_url_window = OverlayUrlWindow(
                self.app,
                self.config_path,
                server_backend=self.server_backend,
                on_close=self._clear_overlay_url_window,
            )
        self._overlay_url_window.show_and_raise()

    def _clear_overlay_url_window(self) -> None:
        self._overlay_url_window = None

    def _current_selected_row(self) -> int | None:
        selection = self.gamepad_list.selection()
        if not selection:
            return None
        return int(selection[0])

    def _would_save_selection(self, selected_row: int) -> GamepadSelection:
        return self.gamepads[selected_row].as_selection(
            pin_identity=self.pin_identity_var.get(),
            pin_port=self.pin_port_var.get(),
        )

    def _update_select_button_state(self) -> None:
        selected_row = self._current_selected_row()
        pin_identity = self.pin_identity_var.get()
        pin_port = self.pin_port_var.get()

        if selected_row is None or selected_row >= len(self.gamepads):
            self.select_button.state(["disabled"])
            return

        if not pin_identity and not pin_port:
            self.select_button.state(["disabled"])
            return

        if pin_port and not self.gamepads[selected_row].port:
            self.select_button.state(["disabled"])
            return

        if self._saved_selection is not None:
            proposed = self._would_save_selection(selected_row)
            if proposed == self._saved_selection:
                self.select_button.state(["disabled"])
                return

        self.select_button.state(["!disabled"])

    def _on_gamepad_list_resize(self, event: tk.Event[tk.Widget]) -> None:
        column_names = ("name", "identity", "port")
        current_widths = [
            int(self.gamepad_list.column(name, "width"))
            for name in column_names
        ]
        total_width = sum(current_widths)
        if total_width <= 0:
            return
        for column_name, width in zip(
            column_names, current_widths, strict=True
        ):
            self.gamepad_list.column(
                column_name,
                width=max(1, int(width / total_width * event.width)),
            )

    def _add_disabled_gamepad_row(self, text: str) -> None:
        self.gamepad_list.insert(
            "", tk.END, iid="disabled", values=(text, "", "")
        )
        self.gamepad_list.selection_remove(self.gamepad_list.selection())

    def _update_connection_state_ui(self) -> None:
        attached = (
            self.server_backend.is_gamepad_connected()
            if self.server_backend is not None
            else False
        )
        client_count = (
            self.server_backend.client_count()
            if self.server_backend is not None
            else 0
        )
        self.root.title(
            _status_text(attached=attached, client_count=client_count)
        )
        if attached != self._window_icon_connected:
            # Updates the root icon (and, via Tk's default, any toplevels
            # opened afterwards such as the quit-confirm dialog).
            self.app.set_window_icon(
                _create_face_buttons_image(connected=attached)
            )
            self._window_icon_connected = attached

    def update_connection_state(self) -> None:
        self.app.run_on_ui_thread(self._update_connection_state_ui)

    def _populate_gamepad_rows(
        self,
        selected: GamepadSelection | None,
        active_gamepad: GamepadInfo | None,
        previous_row: int | None,
    ) -> None:
        selected_row = _selected_gamepad_index(self.gamepads, selected)
        display_names = _gamepad_display_names(self.gamepads)
        active_selection = (
            active_gamepad.as_selection(pin_identity=True, pin_port=False)
            if active_gamepad is not None
            else None
        )
        for index, (gamepad, display_name) in enumerate(
            zip(self.gamepads, display_names, strict=True)
        ):
            is_active = (
                active_selection is not None
                and active_selection.matches(gamepad)
            )
            is_pinned = selected is not None and selected.matches(gamepad)
            if is_active and is_pinned:
                tag = "active_pinned"
            elif is_active:
                tag = "active"
            elif is_pinned:
                tag = "pinned"
            else:
                tag = ""
            row_name = f"★ {display_name}" if is_active else display_name
            vid_pid = gamepad.vid_pid()
            if vid_pid:
                identity_text = f"[{vid_pid}]"
            elif gamepad.guid:
                identity_text = f"[{gamepad.guid}]"
            else:
                identity_text = "No stable identifier"
            port_text = port_display_name(gamepad.port) if gamepad.port else ""
            self.gamepad_list.insert(
                "",
                tk.END,
                iid=str(index),
                values=(row_name, identity_text, port_text),
                tags=(tag,) if tag else (),
            )
        if selected_row is not None:
            self.gamepad_list.selection_set(str(selected_row))
            self.gamepad_list.focus(str(selected_row))
        elif previous_row is not None and previous_row < len(self.gamepads):
            self.gamepad_list.selection_set(str(previous_row))
            self.gamepad_list.focus(str(previous_row))
        self._update_select_button_state()

    def _reload(self) -> None:
        # The tray owns the server lifecycle; _reload only reads from it. (It
        # used to call ensure_started here, but that races the tray's own
        # startup -- the server thread could fire callbacks before self.icon
        # existed.)
        previous_row = self._current_selected_row()
        self.gamepad_list.delete(*self.gamepad_list.get_children())

        previous_selection = self._saved_selection
        self._saved_selection = GamepadSelection.load(self.config_path)
        selected = self._saved_selection
        if selected is not None and selected != previous_selection:
            self.pin_identity_var.set(
                bool(selected.guid or selected.vendor or selected.product)
            )
            self.pin_port_var.set(bool(selected.port))
        active_gamepad = (
            self.server_backend.active_gamepad()
            if self.server_backend is not None
            else None
        )
        self._update_connection_state_ui()

        main_text, detail_text = _mode_texts(selected)
        self.mode_label.configure(text=main_text)
        self.mode_detail_label.configure(text=detail_text)
        if selected is None:
            self.any_button.state(["disabled"])
        else:
            self.any_button.state(["!disabled"])

        try:
            self.gamepads = _list_available_gamepads()
        except RuntimeError as exc:
            logger.exception("Failed to refresh gamepads")
            self.gamepads = []
            self._add_disabled_gamepad_row(str(exc))
            self._update_select_button_state()
            return

        if not self.gamepads:
            self._add_disabled_gamepad_row("No gamepads found")
            self._update_select_button_state()
            return

        guids = [g.guid for g in self.gamepads]
        if len(guids) != len(set(guids)) and not self.pin_port_var.get():
            self.pin_port_var.set(True)

        self._populate_gamepad_rows(selected, active_gamepad, previous_row)

    def show(self) -> None:
        # Refresh the gamepad list, then let TkApp center and reveal the
        # window (its show centers on the primary monitor when withdrawn).
        self.app.run_on_ui_thread(self._reload)
        self.app.show()

    def refresh(self) -> None:
        self.app.run_on_ui_thread(self._reload)

    def select_current_gamepad(self) -> None:
        def _select() -> None:
            selected_row = self._current_selected_row()
            if selected_row is None:
                return
            pin_identity = self.pin_identity_var.get()
            pin_port = self.pin_port_var.get()
            if not pin_identity and not pin_port:
                return
            selection = self.gamepads[selected_row].as_selection(
                pin_identity=pin_identity, pin_port=pin_port
            )
            selection.save(self.config_path)
            self._reload()
            if self.selection_changed_callback is not None:
                self.selection_changed_callback()

        self.app.run_on_ui_thread(_select)

    def use_any_gamepad(self) -> None:
        def _use_any() -> None:
            GamepadSelection.clear(self.config_path)
            self._reload()
            if self.selection_changed_callback is not None:
                self.selection_changed_callback()

        self.app.run_on_ui_thread(_use_any)

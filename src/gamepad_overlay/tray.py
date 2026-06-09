from __future__ import annotations

import logging
import queue
import re
import signal
import subprocess
import sys
import tkinter as tk
from dataclasses import dataclass, field
from threading import Event, Lock, Thread, current_thread
from tkinter import ttk
from typing import TYPE_CHECKING, Any, Protocol, cast

from PIL import Image, ImageDraw

from .application import (
    SDLGamepad,
    ServerRunConfig,
    _clear_selected_gamepad,
    _gamepad_metadata_summary,
    _load_selected_gamepad,
    _save_selected_gamepad,
    _selection_config_path,
    run_server,
)

logger = logging.getLogger(__name__)


class SNIRegistrationError(RuntimeError):
    """Raised when the SNI backend cannot register with a watcher at startup.

    Signals the tray to fall back to a backend that does not require an SNI
    host (the XEmbed icon on legacy X11 setups).
    """


ACTIVE_GAMEPAD_BADGE = "★"
SELECTED_GAMEPAD_BADGE = "Selected"
ICON_BUTTON_SIZE = 24
ICON_BUTTON_STROKE_WIDTH = 3
ICON_BUTTON_CENTERS = {
    "Y": (32.0, 14.0),
    "B": (50.0, 32.0),
    "A": (32.0, 50.0),
    "X": (14.0, 32.0),
}
XBOX_FACE_BUTTON_PRESSED_COLORS = {
    "Y": (255, 255, 51),
    "B": (255, 51, 51),
    "A": (63, 207, 63),
    "X": (51, 119, 255),
}
XBOX_FACE_BUTTON_RELEASED_COLORS = {
    "Y": (95, 95, 31),
    "B": (95, 31, 31),
    "A": (31, 79, 32),
    "X": (31, 31, 95),
}

if TYPE_CHECKING:
    from collections.abc import Callable
    from pathlib import Path


class ServerBackend(Protocol):
    def ensure_started(self) -> None: ...

    def status_label(self) -> str: ...

    def is_gamepad_connected(self) -> bool: ...

    def client_count(self) -> int: ...

    def active_gamepad(self) -> dict[str, object] | None: ...

    def stop(self) -> None: ...


@dataclass
class ManagedServerBackend:
    config_path: Path
    lan: bool = False
    terminal: bool = False
    device_change_callback: Callable[[], None] | None = None
    active_gamepad_callback: (
        Callable[[dict[str, object] | None], None] | None
    ) = None
    client_count_callback: Callable[[int], None] | None = None
    thread: Thread | None = field(default=None, init=False)
    stop_event: Event = field(default_factory=Event, init=False)
    failed: bool = field(default=False, init=False)
    active_gamepad_info: dict[str, object] | None = field(
        default=None, init=False
    )
    connected_client_count: int = field(default=0, init=False)

    def ensure_started(self) -> None:
        if self.thread is not None and self.thread.is_alive():
            return
        self.failed = False
        self.stop_event.clear()
        self.thread = Thread(
            target=self._run_server, name="gamepad-overlay", daemon=True
        )
        self.thread.start()

    def _run_server(self) -> None:
        try:
            run_server(
                ServerRunConfig(
                    config_path=self.config_path,
                    lan=self.lan,
                    terminal=self.terminal,
                    stop_event=self.stop_event,
                    device_change_callback=self.device_change_callback,
                    active_gamepad_callback=self.active_gamepad_callback,
                    client_count_callback=self.client_count_callback,
                )
            )
        except Exception:
            self.failed = True
            logger.exception("Managed gamepad server stopped unexpectedly")

    def status_label(self) -> str:
        if self.thread is not None and self.thread.is_alive():
            return "Server: running"
        if self.failed:
            return "Server: stopped unexpectedly"
        return "Server: stopped"

    def is_gamepad_connected(self) -> bool:
        return self.active_gamepad_info is not None

    def client_count(self) -> int:
        return self.connected_client_count

    def active_gamepad(self) -> dict[str, object] | None:
        return self.active_gamepad_info

    def stop(self) -> None:
        self.stop_event.set()
        if self.thread is not None:
            self.thread.join(timeout=0.2)
        self.active_gamepad_info = None
        self.connected_client_count = 0


def _status_text(*, attached: bool, client_count: int) -> str:
    state = "Attached" if attached else "Detached"
    client_label = "Client" if client_count == 1 else "Clients"
    return (
        f"Gamepad Overlay - {state} "
        f"({client_count} {client_label} Connected)"
    )


def _gamepad_matches_selection(
    gamepad: dict[str, object], selected: dict[str, str] | None
) -> bool:
    return SDLGamepad._matches_selected_gamepad(gamepad, selected)


def _gamepad_selection_identity(gamepad: dict[str, object]) -> dict[str, str]:
    return {
        field_name: str(gamepad.get(field_name, "")).strip()
        for field_name in ("guid", "vendor", "product", "name")
    }


def _gamepad_identity_hint(gamepad: dict[str, object]) -> str:
    metadata = _gamepad_metadata_summary(gamepad, version_first=True)
    return metadata or "No stable identifier exposed"


def _gamepad_display_names(gamepads: list[dict[str, object]]) -> list[str]:
    names = [str(gamepad.get("name", "unknown")) for gamepad in gamepads]
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


def _gamepad_row_label(gamepad: dict[str, object], display_name: str) -> str:
    return f"{display_name}\n{_gamepad_identity_hint(gamepad)}"


def _gamepad_row_badges(
    gamepad: dict[str, object],
    selected: dict[str, str] | None,
    active_gamepad: dict[str, object] | None,
) -> tuple[str, ...]:
    badges: list[str] = []
    if active_gamepad is not None and _gamepad_matches_selection(
        gamepad, _gamepad_selection_identity(active_gamepad)
    ):
        badges.append(ACTIVE_GAMEPAD_BADGE)
    if selected is not None and _gamepad_matches_selection(gamepad, selected):
        badges.append(SELECTED_GAMEPAD_BADGE)
    return tuple(badges)


def _selected_gamepad_index(
    gamepads: list[dict[str, object]], selected: dict[str, str] | None
) -> int | None:
    if selected is None:
        return None
    for index, gamepad in enumerate(gamepads):
        if _gamepad_matches_selection(gamepad, selected):
            return index
    return None


def _rgb_hex(rgb: tuple[int, int, int]) -> str:
    red, green, blue = rgb
    return f"#{red:02x}{green:02x}{blue:02x}"


def _create_face_buttons_image(
    *, connected: bool, size: int = 64
) -> Image.Image:
    # The geometry constants are defined in a 64x64 space. PIL's ellipse is not
    # anti-aliased, so a direct small render turns circles into jagged diamonds.
    # Draw supersampled and downscale with BOX (area averaging) for smooth,
    # round buttons. This anti-aliasing inevitably leaves a faint blended pixel
    # or two where the border meets the fill -- the same thing the window icon
    # shows once the WM downscales it -- which is the price of round (vs.
    # crisp-but-diamond) buttons at this size.
    supersample = 4
    render_size = size * supersample
    image = Image.new("RGBA", (render_size, render_size), (0, 0, 0, 0))
    draw = ImageDraw.Draw(image)
    colors = (
        XBOX_FACE_BUTTON_PRESSED_COLORS
        if connected
        else XBOX_FACE_BUTTON_RELEASED_COLORS
    )
    scale = render_size / 64
    radius = (ICON_BUTTON_SIZE / 2) * scale
    # Border width in *target* pixels (>=1), scaled up for the supersample, so
    # it downscales to an exact integer-pixel line that stays uniformly solid
    # rather than a sub-pixel width that blends into the fill on the diagonals.
    target_stroke = max(1, round(ICON_BUTTON_STROKE_WIDTH * size / 64))
    stroke = target_stroke * supersample
    for button_name, (center_x, center_y) in ICON_BUTTON_CENTERS.items():
        cx = center_x * scale
        cy = center_y * scale
        draw.ellipse(
            (cx - radius, cy - radius, cx + radius, cy + radius),
            fill=colors[button_name],
            outline="black",
            width=stroke,
        )
    if supersample != 1:
        image = image.resize((size, size), Image.Resampling.BOX)
    return image


def _create_tk_window_icon(*, connected: bool) -> tk.PhotoImage:
    image = tk.PhotoImage(width=64, height=64)
    image.blank()
    colors = (
        XBOX_FACE_BUTTON_PRESSED_COLORS
        if connected
        else XBOX_FACE_BUTTON_RELEASED_COLORS
    )
    border_color = "#000000"
    radius = ICON_BUTTON_SIZE / 2
    inner_radius = max(radius - ICON_BUTTON_STROKE_WIDTH, 0)
    outer_radius_squared = radius * radius
    inner_radius_squared = inner_radius * inner_radius

    for y in range(64):
        for x in range(64):
            pixel_x = x + 0.5
            pixel_y = y + 0.5
            pixel_color: str | None = None
            for button_name, (
                center_x,
                center_y,
            ) in ICON_BUTTON_CENTERS.items():
                delta_x = pixel_x - center_x
                delta_y = pixel_y - center_y
                distance_squared = delta_x * delta_x + delta_y * delta_y
                if distance_squared > outer_radius_squared:
                    continue
                pixel_color = (
                    border_color
                    if distance_squared >= inner_radius_squared
                    else _rgb_hex(colors[button_name])
                )
            if pixel_color is not None:
                image.put(pixel_color, (x, y))

    return image


def _list_available_gamepads() -> list[dict[str, object]]:
    return SDLGamepad.list_available_gamepads()


class GamepadSelectorWindow:
    def __init__(
        self,
        config_path: Path,
        *,
        server_backend: ServerBackend | None = None,
        hide_on_close: bool,
        quit_callback: Callable[[], None] | None = None,
        selection_changed_callback: Callable[[], None] | None = None,
    ) -> None:
        self.config_path = config_path
        self.server_backend = server_backend
        self.hide_on_close = hide_on_close
        self.quit_callback = quit_callback
        self.selection_changed_callback = selection_changed_callback
        self.gamepads: list[dict[str, object]] = []
        self._window_icon_connected: bool | None = None
        self._quit_dialog: tk.Toplevel | None = None
        self._ui_ready = Event()
        self._ui_closed = Event()
        self._ui_queue: queue.SimpleQueue[
            tuple[Callable[[], object], Event | None, list[object] | None]
        ] = queue.SimpleQueue()
        self._ui_error: Exception | None = None
        self._poll_after_id: str | None = None
        self._ui_thread = Thread(
            target=self._run_ui_thread,
            name="gamepad-overlay-selector",
            daemon=True,
        )
        self._ui_thread.start()
        self._ui_ready.wait(timeout=5)
        if self._ui_error is not None:
            msg = "Failed to initialize tkinter selector"
            raise RuntimeError(msg) from self._ui_error
        if not self._ui_ready.is_set():
            msg = "Timed out initializing tkinter selector window."
            raise RuntimeError(msg)

    def _on_ui_thread(self) -> bool:
        return current_thread() is self._ui_thread

    def _invoke_ui(self, callback: Callable[[], object]) -> None:
        if self._ui_closed.is_set():
            return
        if self._on_ui_thread():
            callback()
            return
        self._ui_queue.put((callback, None, None))

    def _invoke_ui_sync(self, callback: Callable[[], object]) -> object:
        if self._ui_closed.is_set():
            return False
        if self._on_ui_thread():
            return callback()
        done = Event()
        result: list[object] = []
        self._ui_queue.put((callback, done, result))
        done.wait(timeout=5)
        return result[0] if result else False

    def _poll_ui_queue(self) -> None:
        while True:
            try:
                callback, done, result = self._ui_queue.get_nowait()
            except queue.Empty:
                break
            try:
                value = callback()
                if result is not None:
                    result.append(value)
            except Exception:  # noqa: BLE001
                logger.debug("Error in UI callback", exc_info=True)
            finally:
                if done is not None:
                    done.set()
        if not self._ui_closed.is_set():
            if self._poll_after_id is not None:
                try:
                    self.root.after_cancel(self._poll_after_id)
                except tk.TclError:
                    pass
            self._poll_after_id = self.root.after(25, self._poll_ui_queue)

    def _run_ui_thread(self) -> None:
        try:
            self.root = tk.Tk()
            self._window_icons: dict[bool, object] = {}
            self.root.geometry("640x460")
            self.root.minsize(520, 380)
            self.root.protocol("WM_DELETE_WINDOW", self._dismiss)

            content = ttk.Frame(self.root, padding=18)
            content.pack(fill=tk.BOTH, expand=True)
            content.columnconfigure(0, weight=1)
            content.rowconfigure(0, weight=1)

            list_frame = ttk.Frame(content)
            list_frame.grid(row=0, column=0, sticky="nsew")
            list_frame.columnconfigure(0, weight=1)
            list_frame.rowconfigure(0, weight=1)

            self.gamepad_list = ttk.Treeview(
                list_frame,
                columns=("status", "name", "detail"),
                show="headings",
                selectmode="browse",
            )
            self.gamepad_list.heading("status", text="State")
            self.gamepad_list.heading("name", text="Gamepad")
            self.gamepad_list.heading("detail", text="Identity")
            self.gamepad_list.column(
                "status", width=110, anchor=tk.CENTER, stretch=False
            )
            self.gamepad_list.column("name", width=220, anchor=tk.W)
            self.gamepad_list.column("detail", width=260, anchor=tk.W)
            self.gamepad_list.grid(row=0, column=0, sticky="nsew")
            self.gamepad_list.bind(
                "<<TreeviewSelect>>",
                lambda _event: self._update_select_button_state(),
            )
            self.gamepad_list.bind(
                "<Double-1>", lambda _event: self.select_current_gamepad()
            )

            scrollbar = ttk.Scrollbar(
                list_frame, orient=tk.VERTICAL, command=self.gamepad_list.yview
            )
            scrollbar.grid(row=0, column=1, sticky="ns")
            self.gamepad_list.configure(yscrollcommand=scrollbar.set)

            button_row = ttk.Frame(content)
            button_row.grid(row=1, column=0, sticky="ew", pady=(12, 0))

            self.select_button = ttk.Button(
                button_row,
                text="Select Gamepad",
                command=self.select_current_gamepad,
            )
            self.select_button.pack(side=tk.LEFT)

            ttk.Button(
                button_row,
                text="Use Any Gamepad",
                command=self.use_any_gamepad,
            ).pack(side=tk.LEFT, padx=(8, 0))

            ttk.Button(button_row, text="Refresh", command=self.refresh).pack(
                side=tk.LEFT, padx=(8, 0)
            )

            if self.hide_on_close:
                ttk.Button(
                    button_row, text="Hide", command=self._dismiss
                ).pack(side=tk.RIGHT)

            ttk.Button(
                button_row,
                text="Quit" if self.hide_on_close else "Close",
                command=(
                    self._request_quit if self.hide_on_close else self._dismiss
                ),
            ).pack(
                side=tk.RIGHT, padx=(0, 8) if self.hide_on_close else (0, 0)
            )

            self.root.withdraw()
            self._ui_ready.set()
            self._poll_ui_queue()
            self._refresh_ui()
            self.root.mainloop()
        except tk.TclError as exc:
            self._ui_error = exc
            self._ui_ready.set()
        finally:
            self._ui_closed.set()

    def _dismiss(self) -> None:
        if self.hide_on_close:
            self.root.withdraw()
            return
        self._close_ui()

    def hide(self) -> None:
        self._invoke_ui(self.root.withdraw)

    def _close_ui(self) -> bool:
        if self._ui_closed.is_set():
            return False
        try:
            self.root.destroy()
        except tk.TclError:
            return False
        return True

    def _current_selected_row(self) -> int | None:
        selection = self.gamepad_list.selection()
        if not selection:
            return None
        return int(selection[0])

    def _update_select_button_state(self) -> None:
        selected_row = self._current_selected_row()
        self.select_button.state(
            ["!disabled"] if selected_row is not None else ["disabled"]
        )

    def _add_disabled_gamepad_row(self, text: str) -> None:
        self.gamepad_list.insert(
            "", tk.END, iid="disabled", values=("", text, "")
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
            icon = self._window_icons.get(attached)
            if icon is None:
                icon = _create_tk_window_icon(connected=attached)
                self._window_icons[attached] = icon
            self.root.iconphoto(True, cast("tk.PhotoImage", icon))
            self._window_icon_connected = attached
            if self._quit_dialog is not None:
                try:
                    self._quit_dialog.iconphoto(True, cast("tk.PhotoImage", icon))
                    self._quit_dialog.update_idletasks()
                except tk.TclError:
                    pass

    def _update_connection_state(self) -> None:
        self._invoke_ui(self._update_connection_state_ui)

    def _request_quit(self) -> None:
        if self.quit_callback is not None:
            self.quit_callback()

    def _refresh_ui(self) -> None:
        if self.server_backend is not None:
            self.server_backend.ensure_started()

        previous_row = self._current_selected_row()
        self.gamepad_list.delete(*self.gamepad_list.get_children())

        try:
            self.gamepads = _list_available_gamepads()
        except RuntimeError as exc:
            logger.exception("Failed to refresh gamepads")
            self.gamepads = []
            self._update_connection_state_ui()
            self._add_disabled_gamepad_row(str(exc))
            self.select_button.state(["disabled"])
            return

        selected = _load_selected_gamepad(self.config_path)
        active_gamepad = (
            self.server_backend.active_gamepad()
            if self.server_backend is not None
            else None
        )
        self._update_connection_state_ui()

        if not self.gamepads:
            self._add_disabled_gamepad_row("No gamepads found")
            self.select_button.state(["disabled"])
            return

        selected_row = _selected_gamepad_index(self.gamepads, selected)
        display_names = _gamepad_display_names(self.gamepads)
        for index, (gamepad, display_name) in enumerate(
            zip(self.gamepads, display_names, strict=True)
        ):
            badges = " ".join(
                _gamepad_row_badges(gamepad, selected, active_gamepad)
            )
            self.gamepad_list.insert(
                "",
                tk.END,
                iid=str(index),
                values=(badges, display_name, _gamepad_identity_hint(gamepad)),
            )

        if selected_row is not None:
            self.gamepad_list.selection_set(str(selected_row))
            self.gamepad_list.focus(str(selected_row))
        elif previous_row is not None and previous_row < len(self.gamepads):
            self.gamepad_list.selection_set(str(previous_row))
            self.gamepad_list.focus(str(previous_row))
        self._update_select_button_state()

    def show(self) -> None:
        def _show() -> None:
            self._refresh_ui()
            if self.root.state() == "withdrawn":
                mx, my, mw, mh = self._primary_monitor_bounds()
                ww = self.root.winfo_reqwidth()
                wh = self.root.winfo_reqheight()
                x = mx + max(0, (mw - ww) // 2)
                y = my + max(0, (mh - wh) // 3)
                self.root.geometry(f"+{x}+{y}")
            self.root.deiconify()
            self.root.lift()
            self.root.focus_force()

        self._invoke_ui(_show)

    def is_visible(self) -> bool:
        return bool(
            self._invoke_ui_sync(
                lambda: self.root.state() != "withdrawn"
                and self.root.winfo_viewable()
            )
        )

    def _primary_monitor_bounds(self) -> tuple[int, int, int, int]:
        try:
            result = subprocess.run(
                ["xrandr", "--current"],
                capture_output=True,
                text=True,
                timeout=2,
            )
            for line in result.stdout.splitlines():
                if "primary" in line:
                    match = re.search(
                        r"(\d+)x(\d+)\+(\d+)\+(\d+)", line
                    )
                    if match:
                        w, h, x, y = map(int, match.groups())
                        return (x, y, w, h)
        except Exception:
            pass
        sw = self.root.winfo_screenwidth()
        sh = self.root.winfo_screenheight()
        return (0, 0, sw, sh)

    def refresh(self) -> None:
        self._invoke_ui(self._refresh_ui)

    def confirm_quit(self) -> bool:
        def _confirm() -> bool:
            result = tk.BooleanVar(value=False)

            d = tk.Toplevel()
            d.title("Quit Gamepad Overlay")
            d.resizable(False, False)
            if str(self.root.state()) != "withdrawn":
                d.transient(self.root)

            # Copy the main window icon to the dialog title bar
            if self._window_icon_connected is not None:
                icon = self._window_icons.get(self._window_icon_connected)
                if icon is not None:
                    try:
                        d.iconphoto(True, cast("tk.PhotoImage", icon))
                    except tk.TclError:
                        pass

            frame = ttk.Frame(d, padding=20)
            frame.pack()

            ttk.Label(
                frame,
                text="Quit the tray and stop the managed gamepad server?",
                wraplength=300,
            ).pack(pady=(0, 10))

            btn_frame = ttk.Frame(frame)
            btn_frame.pack()

            def _done() -> None:
                self._quit_dialog = None
                d.destroy()

            def _yes() -> None:
                result.set(True)
                _done()

            def _no() -> None:
                result.set(False)
                _done()

            ttk.Button(btn_frame, text="Yes", command=_yes).pack(
                side=tk.LEFT, padx=5
            )
            ttk.Button(btn_frame, text="No", command=_no).pack(
                side=tk.LEFT, padx=5
            )

            dw = d.winfo_reqwidth()
            dh = d.winfo_reqheight()
            if str(self.root.state()) != "withdrawn":
                rx = self.root.winfo_x()
                ry = self.root.winfo_y()
                rw = self.root.winfo_width()
                rh = self.root.winfo_height()
                x = rx + (rw - dw) // 2
                y = ry + (rh - dh) // 2
            else:
                mx, my, mw, mh = self._primary_monitor_bounds()
                x = mx + max(0, (mw - dw) // 2)
                y = my + max(0, (mh - dh) // 3)
            d.geometry(f"+{x}+{y}")
            d.update_idletasks()
            self._quit_dialog = d
            d.grab_set()
            d.focus_set()
            d.wait_window()

            return result.get()

        return bool(self._invoke_ui_sync(_confirm))

    def select_current_gamepad(self) -> None:
        def _select() -> None:
            selected_row = self._current_selected_row()
            if selected_row is None:
                return
            _save_selected_gamepad(
                self.config_path, self.gamepads[selected_row]
            )
            self._refresh_ui()
            if self.selection_changed_callback is not None:
                self.selection_changed_callback()

        self._invoke_ui(_select)

    def use_any_gamepad(self) -> None:
        def _use_any() -> None:
            _clear_selected_gamepad(self.config_path)
            self._refresh_ui()
            if self.selection_changed_callback is not None:
                self.selection_changed_callback()

        self._invoke_ui(_use_any)

    def close(self) -> None:
        self._invoke_ui_sync(self._close_ui)
        if self._ui_thread.is_alive() and not self._on_ui_thread():
            self._ui_thread.join(timeout=1)


def _tray_icon_renderer(connected: bool) -> Callable[[int], Image.Image]:
    """Return a callable that renders the tray icon natively at a given size."""

    def render(size: int) -> Image.Image:
        return _create_face_buttons_image(connected=connected, size=size)

    return render


class _PystrayIcon:
    """Adapt pystray.Icon to the render-based icon interface used here."""

    _WINDOWS_ICON_SIZE = 64

    def __init__(
        self,
        name: str,
        title: str,
        render_icon: Callable[[int], Image.Image],
        *,
        on_activate: Callable[[], None],
        on_quit: Callable[[], None],
    ) -> None:
        import pystray  # type: ignore[import-untyped]

        menu = pystray.Menu(
            pystray.MenuItem(
                "Configure...", lambda _i, _it: on_activate(), default=True
            ),
            pystray.MenuItem("Quit", lambda _i, _it: on_quit()),
        )
        self._icon = pystray.Icon(
            name,
            icon=render_icon(self._WINDOWS_ICON_SIZE),
            title=title,
            menu=menu,
        )

    def set_icon(self, render_icon: Callable[[int], Image.Image]) -> None:
        self._icon.icon = render_icon(self._WINDOWS_ICON_SIZE)

    @property
    def title(self) -> str:
        return str(self._icon.title)

    @title.setter
    def title(self, value: str) -> None:
        self._icon.title = value

    @property
    def visible(self) -> bool:
        return bool(self._icon.visible)

    @visible.setter
    def visible(self, value: bool) -> None:
        self._icon.visible = value

    def run(self, setup: Callable[[object], None] | None = None) -> None:
        self._icon.run(setup=setup)

    def stop(self) -> None:
        self._icon.stop()


def _make_tray_icon(  # noqa: PLR0913
    name: str,
    title: str,
    render_icon: Callable[[int], Image.Image],
    *,
    on_activate: Callable[[], None],
    on_quit: Callable[[], None],
    force_xembed: bool = False,
) -> Any:  # noqa: ANN401
    """Create a platform-appropriate tray icon with a uniform interface.

    The icon source is a ``render_icon(size) -> Image`` callable so each
    backend can draw the icon natively at whatever size it needs instead of
    rescaling one master image.

    * Windows/macOS use pystray (native, reliable there).
    * Linux prefers the StatusNotifierItem backend when an SNI host is present
      (KDE/GNOME, Wayland, or fluxbox with snixembed). This is the only path
      that works on Wayland and the only one where the host handles clicks on
      transparent pixels for us. If it later fails to register, the caller
      falls back to XEmbed via :class:`SNIRegistrationError`.
    * Otherwise (bare X11 WMs with only the legacy XEmbed systray) it uses a
      self-contained XEmbed icon. ``force_xembed`` selects this directly.
    """
    if sys.platform in ("win32", "darwin"):
        return _PystrayIcon(
            name, title, render_icon, on_activate=on_activate, on_quit=on_quit
        )

    if not force_xembed:
        from .tray_sni import SNITrayIcon, sni_watcher_present

        if sni_watcher_present():
            return SNITrayIcon(
                title,
                render_icon,
                on_activate=on_activate,
                on_secondary=on_activate,
                on_quit=on_quit,
            )

    from .tray_xembed import XEmbedTrayIcon

    return XEmbedTrayIcon(
        name, title, render_icon, on_activate=on_activate, on_quit=on_quit
    )


class GamepadSelectorTray:
    def __init__(
        self,
        config_path: Path | None = None,
        *,
        lan: bool = False,
        terminal: bool = False,
    ) -> None:
        self.config_path = config_path or _selection_config_path()
        self.server_backend = ManagedServerBackend(
            config_path=self.config_path,
            lan=lan,
            terminal=terminal,
            device_change_callback=self._refresh_from_backend,
            active_gamepad_callback=self._handle_active_gamepad_changed,
            client_count_callback=self._handle_client_count_changed,
        )
        self.server_backend.ensure_started()
        self.window = GamepadSelectorWindow(
            self.config_path,
            server_backend=self.server_backend,
            hide_on_close=True,
            quit_callback=self._request_quit,
            selection_changed_callback=self._sync_connection_state,
        )
        self._tray_lock = Lock()
        self._tray_icon_connected: bool | None = None
        self._tray_title = _status_text(attached=False, client_count=0)
        self._start_hidden = False
        self.icon: Any = self._create_icon()
        self._sync_connection_state()

    def _create_icon(
        self, *, force_xembed: bool = False
    ) -> Any:  # noqa: ANN401
        return _make_tray_icon(
            "gamepad-overlay",
            self._tray_title,
            _tray_icon_renderer(self._tray_icon_connected or False),
            on_activate=self.window.show,
            on_quit=self._request_quit,
            force_xembed=force_xembed,
        )

    def _apply_tray_state(self) -> None:
        with self._tray_lock:
            connected = self.server_backend.is_gamepad_connected()
            title = _status_text(
                attached=connected,
                client_count=self.server_backend.client_count(),
            )
            self.icon.title = title
            if connected != self._tray_icon_connected:
                self.icon.set_icon(_tray_icon_renderer(connected))
                self._tray_icon_connected = connected
            self._tray_title = title

    def _refresh_from_backend(self) -> None:
        self.window.refresh()
        self._sync_connection_state()

    def _handle_active_gamepad_changed(self, active_gamepad: object) -> None:
        self.server_backend.active_gamepad_info = (
            active_gamepad if isinstance(active_gamepad, dict) else None
        )
        self.window.refresh()
        self._sync_connection_state()

    def _handle_client_count_changed(self, client_count: int) -> None:
        self.server_backend.connected_client_count = client_count
        self._sync_connection_state()

    def _sync_connection_state(self) -> None:
        self.window._update_connection_state()
        self._apply_tray_state()

    def _request_quit(self) -> None:
        def _do_quit() -> None:
            if not self.window.confirm_quit():
                return
            self._quit()

        self.window._invoke_ui(_do_quit)

    def _quit(self) -> None:
        self.window.close()
        self.server_backend.stop()
        self.icon.stop()

    def _setup(self, icon: object) -> None:  # noqa: ARG002
        self.icon.visible = True
        self._apply_tray_state()
        if not self._start_hidden:
            self.window.show()

    def run(self, *, start_hidden: bool = False) -> int:
        self._start_hidden = start_hidden
        try:
            self.icon.run(setup=self._setup)
        except SNIRegistrationError:
            logger.warning(
                "StatusNotifierItem registration failed; "
                "falling back to the XEmbed tray icon"
            )
            self.icon = self._create_icon(force_xembed=True)
            self.icon.run(setup=self._setup)
        return 0


def _install_signal_handlers(
    quit_callback: Callable[[], None],
) -> list[tuple[int, Any]]:
    handlers: list[tuple[int, Any]] = []

    def handle_signal(_signum: int, _frame: object | None) -> None:
        quit_callback()

    handlers.append(
        (signal.SIGINT, signal.signal(signal.SIGINT, handle_signal))
    )
    if hasattr(signal, "SIGTERM"):
        handlers.append(
            (signal.SIGTERM, signal.signal(signal.SIGTERM, handle_signal))
        )
    return handlers


def _restore_signal_handlers(handlers: list[tuple[int, Any]]) -> None:
    for signum, previous_handler in handlers:
        signal.signal(signum, previous_handler)


def run_tray(
    *,
    config_path: Path | None = None,
    lan: bool = False,
    terminal: bool = False,
    start_hidden: bool = False,
) -> int:
    tray = GamepadSelectorTray(config_path, lan=lan, terminal=terminal)
    handlers = _install_signal_handlers(tray._quit)
    try:
        return tray.run(start_hidden=start_hidden)
    finally:
        _restore_signal_handlers(handlers)

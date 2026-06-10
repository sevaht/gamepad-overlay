"""The tkinter gamepad-selector window and its supporting helpers."""

from __future__ import annotations

import contextlib
import logging
import queue
import re
import subprocess
import tkinter as tk
from threading import Event, Thread, current_thread
from tkinter import ttk
from typing import TYPE_CHECKING, Protocol, cast

from .application import (
    SDLGamepad,
    _clear_selected_gamepad,
    _gamepad_metadata_summary,
    _load_selected_gamepad,
    _save_selected_gamepad,
)
from .tray_render import _create_tk_window_icon

if TYPE_CHECKING:
    from collections.abc import Callable
    from pathlib import Path

logger = logging.getLogger(__name__)

ACTIVE_GAMEPAD_BADGE = "★"
SELECTED_GAMEPAD_BADGE = "Selected"


class ServerBackend(Protocol):
    def ensure_started(self) -> None: ...

    def status_label(self) -> str: ...

    def is_gamepad_connected(self) -> bool: ...

    def client_count(self) -> int: ...

    def active_gamepad(self) -> dict[str, object] | None: ...

    def stop(self) -> None: ...


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
                # A queued UI callback may raise anything; one bad callback
                # must not tear down the Tk event loop, so swallow and log it.
                logger.debug("Error in UI callback", exc_info=True)
            finally:
                if done is not None:
                    done.set()
        if not self._ui_closed.is_set():
            if self._poll_after_id is not None:
                with contextlib.suppress(tk.TclError):
                    self.root.after_cancel(self._poll_after_id)
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
                    self._quit_dialog.iconphoto(
                        True, cast("tk.PhotoImage", icon)
                    )
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
                ["xrandr", "--current"],  # noqa: S607
                capture_output=True,
                text=True,
                timeout=2,
                check=False,
            )
            for line in result.stdout.splitlines():
                if "primary" in line:
                    match = re.search(r"(\d+)x(\d+)\+(\d+)\+(\d+)", line)
                    if match:
                        w, h, x, y = map(int, match.groups())
                        return (x, y, w, h)
        except (OSError, subprocess.SubprocessError):
            logger.debug(
                "Could not query xrandr for monitor bounds", exc_info=True
            )
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
                    with contextlib.suppress(tk.TclError):
                        d.iconphoto(True, cast("tk.PhotoImage", icon))

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

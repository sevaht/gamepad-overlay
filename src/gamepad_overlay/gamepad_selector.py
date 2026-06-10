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
    GAMEPAD_SELECTION_FIELDS,
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
    metadata = _gamepad_metadata_summary(gamepad)
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


def _selected_gamepad_index(
    gamepads: list[dict[str, object]], selected: dict[str, str] | None
) -> int | None:
    if selected is None:
        return None
    for index, gamepad in enumerate(gamepads):
        if _gamepad_matches_selection(gamepad, selected):
            return index
    return None


def _mode_texts(selected: dict[str, str] | None) -> tuple[str, str]:
    """Return (name_line, detail_line) for the mode bar (no prefix — caller adds 'Target:')."""
    if selected is None:
        return ("Any available gamepad", "")
    has_identity = any(
        selected.get(f, "") for f in ("guid", "vendor", "product")
    )
    has_port = bool(selected.get("port", ""))
    if not has_identity and not has_port:
        return ("Any available gamepad", "")
    name = selected.get("name", "") or "Unknown controller"
    main = name if has_identity else "Any controller"
    detail = _gamepad_metadata_summary(selected)
    return (main, detail)


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
        self._saved_selection: dict[str, str] | None = None
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

    def _run_ui_thread(self) -> None:  # noqa: PLR0915
        try:
            self.root = tk.Tk()
            ttk.Style().theme_use("clam")
            self._window_icons: dict[bool, object] = {}
            self.root.geometry("650x500")
            self.root.minsize(650, 420)
            self.root.protocol("WM_DELETE_WINDOW", self._dismiss)

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
                columns=("name", "detail"),
                show="headings",
                selectmode="browse",
            )
            self.gamepad_list.heading("name", text="Gamepad")
            self.gamepad_list.heading("detail", text="Details")
            self.gamepad_list.column("name", width=300, anchor=tk.W)
            self.gamepad_list.column("detail", width=280, anchor=tk.W)
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

            # tk.Frame groove box + separate Label above: uniform pady=6 on all
            # sides so the separator gap is symmetric (ttk.LabelFrame's embedded
            # title creates an inherent top-heavy asymmetry that can't be padding'd away).
            criteria_outer = ttk.Frame(bottom_row)
            criteria_outer.pack(side=tk.LEFT, anchor="sw")

            ttk.Label(criteria_outer, text="Criteria").pack(anchor="w", padx=2)

            criteria_box = tk.Frame(
                criteria_outer, relief="groove", borderwidth=2
            )
            criteria_box.pack()

            left_frame = ttk.Frame(criteria_box)
            left_frame.grid(row=0, column=0, sticky="nsw", padx=(6, 0), pady=6)

            ttk.Checkbutton(
                left_frame,
                text="Controller identity",
                variable=self.pin_identity_var,
            ).pack(anchor="w")
            ttk.Checkbutton(
                left_frame, text="Connection", variable=self.pin_port_var
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

            ttk.Separator(criteria_box, orient=tk.VERTICAL).grid(
                row=0, column=1, sticky="nsew", padx=10, pady=6
            )

            self.any_button = ttk.Button(
                criteria_box, text="Any Gamepad", command=self.use_any_gamepad
            )
            self.any_button.grid(
                row=0, column=2, sticky="sw", padx=(0, 6), pady=6
            )

            # Right side of bottom_row: Quit / Hide
            if self.hide_on_close:
                ttk.Button(
                    bottom_row, text="Hide", command=self._dismiss
                ).pack(side=tk.RIGHT, anchor="s")

            ttk.Button(
                bottom_row,
                text="Quit" if self.hide_on_close else "Close",
                command=(
                    self._request_quit if self.hide_on_close else self._dismiss
                ),
            ).pack(
                side=tk.RIGHT,
                anchor="s",
                padx=(0, 8) if self.hide_on_close else (0, 0),
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

    def _would_save_selection(self, selected_row: int) -> dict[str, str]:
        gamepad = self.gamepads[selected_row]
        result = {
            field: str(gamepad.get(field, "")).strip()
            for field in GAMEPAD_SELECTION_FIELDS
        }
        if not self.pin_identity_var.get():
            for field in ("guid", "vendor", "product"):
                result[field] = ""
        if not self.pin_port_var.get():
            result["port"] = ""
        return result

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

        port = str(self.gamepads[selected_row].get("port", "")).strip()
        if pin_port and not port:
            self.select_button.state(["disabled"])
            return

        if self._saved_selection is not None:
            proposed = self._would_save_selection(selected_row)
            if all(
                proposed.get(f, "") == self._saved_selection.get(f, "")
                for f in GAMEPAD_SELECTION_FIELDS
            ):
                self.select_button.state(["disabled"])
                return

        self.select_button.state(["!disabled"])

    def _add_disabled_gamepad_row(self, text: str) -> None:
        self.gamepad_list.insert("", tk.END, iid="disabled", values=(text, ""))
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

    def _refresh_ui(self) -> None:  # noqa: C901, PLR0912
        if self.server_backend is not None:
            self.server_backend.ensure_started()

        previous_row = self._current_selected_row()
        self.gamepad_list.delete(*self.gamepad_list.get_children())

        self._saved_selection = _load_selected_gamepad(self.config_path)
        selected = self._saved_selection
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

        guids = [str(g.get("guid", "")) for g in self.gamepads]
        if len(guids) != len(set(guids)) and not self.pin_port_var.get():
            self.pin_port_var.set(True)

        selected_row = _selected_gamepad_index(self.gamepads, selected)
        display_names = _gamepad_display_names(self.gamepads)
        active_identity = (
            _gamepad_selection_identity(active_gamepad)
            if active_gamepad is not None
            else None
        )
        for index, (gamepad, display_name) in enumerate(
            zip(self.gamepads, display_names, strict=True)
        ):
            is_active = (
                active_identity is not None
                and _gamepad_matches_selection(gamepad, active_identity)
            )
            is_pinned = selected is not None and _gamepad_matches_selection(
                gamepad, selected
            )

            if is_active and is_pinned:
                tag = "active_pinned"
            elif is_active:
                tag = "active"
            elif is_pinned:
                tag = "pinned"
            else:
                tag = ""

            row_name = f"★ {display_name}" if is_active else display_name
            self.gamepad_list.insert(
                "",
                tk.END,
                iid=str(index),
                values=(row_name, _gamepad_identity_hint(gamepad)),
                tags=(tag,) if tag else (),
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
            pin_identity = self.pin_identity_var.get()
            pin_port = self.pin_port_var.get()
            if not pin_identity and not pin_port:
                return
            gamepad_to_save = dict(self.gamepads[selected_row])
            if not pin_identity:
                for field in ("guid", "vendor", "product"):
                    gamepad_to_save[field] = ""
            if not pin_port:
                gamepad_to_save["port"] = ""
            _save_selected_gamepad(self.config_path, gamepad_to_save)
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

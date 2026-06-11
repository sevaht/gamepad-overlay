"""A self-contained XEmbed system tray icon for legacy X11 setups.

This is the fallback used on bare X11 window managers (e.g. fluxbox) that
provide only the freedesktop XEmbed systray and have no StatusNotifierItem
host on the session bus. Unlike pystray's ``_xorg`` backend it:

* gives the icon window a ``ParentRelative`` background and paints only the
  opaque pixels through a 1-bit clip mask, so transparent areas show the
  tray's own background instead of a black rectangle (no ARGB visual or
  compositor required, which matters because trays like fluxbox advertise no
  ``_NET_SYSTEM_TRAY_VISUAL``);
* selects ``ButtonPressMask`` on the whole icon rectangle and never sets an
  input shape, so clicks on transparent pixels are delivered just like clicks
  on opaque ones (no ``grab_button`` hack required);
* dispatches left-click to ``on_activate`` and right-click to ``on_quit``.

It implements the ``TrayIcon`` interface from :mod:`gamepad_overlay.tray_backend`
(``set_icon`` / ``title`` / ``visible`` plus :meth:`run` and :meth:`stop`).
"""

from __future__ import annotations

import logging
import queue
import threading
from typing import TYPE_CHECKING, Any

import PIL.Image
import Xlib.display
import Xlib.error
import Xlib.threaded  # enables python-xlib's cross-thread locking
import Xlib.X
import Xlib.Xutil

if TYPE_CHECKING:
    from collections.abc import Callable

    from PIL import Image
    from Xlib.display import Event

logger = logging.getLogger(__name__)

_SYSTEM_TRAY_REQUEST_DOCK = 0
_XEMBED_VERSION = 0
_XEMBED_MAPPED = 1
_DEFAULT_ICON_SIZE = 24
_ALPHA_THRESHOLD = 128
_BUTTON_PRIMARY = 1
_BUTTON_SECONDARY = 3
# Fraction of the tray cell the icon fills. SNI hosts render icons inside a
# small standard margin rather than edge-to-edge; inset ours to match. Tweak
# if it ends up larger/smaller than neighbouring tray icons.
_ICON_FILL_FRACTION = 0.9


class XEmbedTrayIcon:
    def __init__(
        self,
        name: str,
        title: str,
        render_icon: Callable[[int], Image.Image],
        *,
        on_activate: Callable[[], None] | None = None,
        on_quit: Callable[[], None] | None = None,
    ) -> None:
        self._name = name
        self._title = title
        self._render_icon = render_icon
        self._on_activate = on_activate
        self._on_quit = on_quit

        self._display = Xlib.display.Display()
        self._screen = self._display.screen()
        self._window: Any = None
        self._gc: Any = None
        self._systray_manager: Any = None
        self._thread: threading.Thread | None = None
        self._stopped = threading.Event()
        self._tasks: queue.Queue[Callable[[], None]] = queue.Queue()
        self._setup: Callable[[object], None] | None = None

        self._atom_xembed_info = self._display.intern_atom("_XEMBED_INFO")
        self._atom_systray_selection = self._display.intern_atom(
            f"_NET_SYSTEM_TRAY_S{self._display.get_default_screen()}"
        )
        self._atom_systray_opcode = self._display.intern_atom(
            "_NET_SYSTEM_TRAY_OPCODE"
        )
        self._atom_manager = self._display.intern_atom("MANAGER")
        self._atom_wake = self._display.intern_atom("_GAMEPAD_OVERLAY_WAKE")

    # -- pystray-compatible surface ---------------------------------------

    @property
    def visible(self) -> bool:
        return True

    @visible.setter
    def visible(self, value: bool) -> None:
        pass

    @property
    def title(self) -> str:
        return self._title

    @title.setter
    def title(self, value: str) -> None:
        self._title = value
        self._post(lambda: self._window.set_wm_name(value))

    def set_icon(self, render_icon: Callable[[int], Image.Image]) -> None:
        self._render_icon = render_icon
        self._post(self._draw)

    def run(self, setup: Callable[[object], None] | None = None) -> None:
        self._setup = setup
        self._thread = threading.current_thread()
        self._create_window()
        self._gc = self._window.create_gc()
        # Listen for MANAGER messages so we can re-dock if the tray restarts.
        self._screen.root.change_attributes(
            event_mask=Xlib.X.StructureNotifyMask
        )
        self._dock()
        if self._setup is not None:
            self._setup(self)
        self._mainloop()

    def stop(self) -> None:
        self._post(self._do_stop)

    # -- internals --------------------------------------------------------

    def _on_ui_thread(self) -> bool:
        return (
            self._thread is not None
            and threading.current_thread().ident == self._thread.ident
        )

    def _post(self, task: Callable[[], None]) -> None:
        """Schedule ``task`` to run on the X event-loop thread."""
        if self._stopped.is_set():
            return
        if self._on_ui_thread():
            task()
            return
        self._tasks.put(task)
        if self._window is not None:
            try:
                self._wake()
            except Xlib.error.XError:
                logger.debug("Failed to wake tray event loop", exc_info=True)

    def _wake(self) -> None:
        self._display.send_event(
            self._window,
            Xlib.display.event.ClientMessage(
                type=Xlib.X.ClientMessage,
                client_type=self._atom_wake,
                window=self._window.id,
                data=(32, (0, 0, 0, 0, 0)),
            ),
            event_mask=Xlib.X.NoEventMask,
        )
        self._display.flush()

    def _drain_tasks(self) -> None:
        while True:
            try:
                task = self._tasks.get_nowait()
            except queue.Empty:
                return
            try:
                task()
            except Xlib.error.XError:
                logger.debug("Error running tray task", exc_info=True)

    def _do_stop(self) -> None:
        self._stopped.set()
        try:
            self._window.destroy()
            self._display.flush()
        except Xlib.error.XError:
            logger.debug("Error destroying tray window", exc_info=True)

    def _create_window(self) -> None:
        # Use the tray's (default) visual at the parent's depth with a
        # ParentRelative background, so untouched pixels inherit the tray's
        # background and look transparent. The input region stays the full
        # rectangle, so clicks land everywhere regardless of pixel alpha.
        self._window = self._screen.root.create_window(
            -1,
            -1,
            _DEFAULT_ICON_SIZE,
            _DEFAULT_ICON_SIZE,
            0,
            self._screen.root_depth,
            window_class=Xlib.X.InputOutput,
            background_pixmap=Xlib.X.ParentRelative,
            event_mask=(
                Xlib.X.ExposureMask
                | Xlib.X.StructureNotifyMask
                | Xlib.X.ButtonPressMask
            ),
        )
        self._window.set_wm_class(f"{self._name}SystemTrayIcon", self._name)
        self._window.set_wm_name(self._title)
        self._window.set_wm_normal_hints(
            flags=(
                Xlib.Xutil.PPosition | Xlib.Xutil.PSize | Xlib.Xutil.PMinSize
            ),
            min_width=_DEFAULT_ICON_SIZE,
            min_height=_DEFAULT_ICON_SIZE,
        )
        self._window.change_property(
            self._atom_xembed_info,
            self._atom_xembed_info,
            32,
            [_XEMBED_VERSION, _XEMBED_MAPPED],
        )

    def _dock(self) -> None:
        self._display.grab_server()
        try:
            owner = self._display.get_selection_owner(
                self._atom_systray_selection
            )
        finally:
            self._display.ungrab_server()
        if owner == Xlib.X.NONE:
            logger.info(
                "No XEmbed systray owner yet; will dock when one starts"
            )
            return
        self._systray_manager = self._display.create_resource_object(
            "window", owner.id
        )
        self._systray_manager.change_attributes(
            event_mask=Xlib.X.StructureNotifyMask
        )
        self._display.send_event(
            self._systray_manager,
            Xlib.display.event.ClientMessage(
                type=Xlib.X.ClientMessage,
                client_type=self._atom_systray_opcode,
                window=self._systray_manager.id,
                data=(
                    32,
                    (
                        Xlib.X.CurrentTime,
                        _SYSTEM_TRAY_REQUEST_DOCK,
                        self._window.id,
                        0,
                        0,
                    ),
                ),
            ),
            event_mask=Xlib.X.NoEventMask,
        )
        self._display.flush()

    def _draw(self) -> None:
        if self._window is None or self._gc is None:
            return
        try:
            geometry = self._window.get_geometry()
        except Xlib.error.BadDrawable:
            return
        width = max(1, geometry.width)
        height = max(1, geometry.height)
        # Render natively at the allocated size, inset to match host-rendered
        # (SNI) icons, and center it in the cell.
        size = min(width, height)
        icon_size = max(1, round(size * _ICON_FILL_FRACTION))
        image = self._render_icon(icon_size).convert("RGBA")
        self._paint_masked(
            image, (width - icon_size) // 2, (height - icon_size) // 2
        )

    def _paint_masked(
        self, image: Image.Image, offset_x: int, offset_y: int
    ) -> None:
        # Build a 1-bit mask of the opaque pixels, clear the window back to its
        # ParentRelative background, then draw the RGB image clipped to the
        # mask so only opaque pixels are painted (centered at the offset).
        width, height = image.size
        bilevel = (
            image.getchannel("A")
            .point(lambda a: 255 if a >= _ALPHA_THRESHOLD else 0)
            .convert("1", dither=PIL.Image.Dither.NONE)
        )
        mask = self._window.create_pixmap(width, height, 1)
        mask_gc = mask.create_gc(foreground=1, background=0)
        try:
            mask.put_pil_image(mask_gc, 0, 0, bilevel)
            # exposures=False: a self-generated Expose would re-trigger _draw.
            self._window.clear_area(exposures=False)
            self._gc.change(
                clip_mask=mask, clip_x_origin=offset_x, clip_y_origin=offset_y
            )
            self._window.put_pil_image(
                self._gc, offset_x, offset_y, image.convert("RGB")
            )
            self._gc.change(clip_mask=Xlib.X.NONE)
        except Xlib.error.BadDrawable:
            return
        finally:
            mask_gc.free()
            mask.free()

    def _on_button_press(self, event: Event) -> None:
        if event.detail == _BUTTON_PRIMARY and self._on_activate is not None:
            self._on_activate()
        elif event.detail == _BUTTON_SECONDARY and self._on_quit is not None:
            self._on_quit()

    def _on_client_message(self, event: Event) -> None:
        if event.client_type == self._atom_wake:
            self._drain_tasks()
        elif (
            event.client_type == self._atom_manager
            and len(event.data[1]) > 1
            and event.data[1][1] == self._atom_systray_selection
        ):
            # The systray manager (re)started; (re)dock into it.
            self._systray_manager = None
            self._dock()
            self._draw()

    def _on_destroy_notify(self, event: Event) -> None:
        if (
            self._systray_manager is not None
            and event.window.id == self._systray_manager.id
        ):
            self._systray_manager = None

    def _mainloop(self) -> None:
        while not self._stopped.is_set():
            try:
                event = self._display.next_event()
            except Xlib.error.ConnectionClosedError:
                break
            if event.type == Xlib.X.DestroyNotify:
                if event.window.id == self._window.id:
                    break
                self._on_destroy_notify(event)
            elif event.type == Xlib.X.ClientMessage:
                self._on_client_message(event)
            elif event.type in (Xlib.X.Expose, Xlib.X.ConfigureNotify):
                if event.window.id == self._window.id:
                    self._draw()
            elif event.type == Xlib.X.ButtonPress:
                self._on_button_press(event)
        self._stopped.set()

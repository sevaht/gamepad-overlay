from __future__ import annotations

import asyncio
import contextlib
import logging
import signal as _signal
from typing import TYPE_CHECKING

from dbus_next import BusType, Variant
from dbus_next.aio import MessageBus
from dbus_next.constants import PropertyAccess
from dbus_next.service import ServiceInterface, dbus_property, method
from dbus_next.service import signal as dbus_signal
from PIL import Image

from .tray_backend import SNIRegistrationError

if TYPE_CHECKING:
    from collections.abc import Callable

logger = logging.getLogger(__name__)

SNI_OBJECT_PATH = "/StatusNotifierItem"
DBUS_MENU_OBJECT_PATH = "/com/canonical/dbusmenu"
# A single, generously sized square pixmap. Offering several sizes makes some
# hosts (e.g. snixembed) scale non-uniformly or pick oddly; one source lets the
# host do a single uniform scale. Keep it comfortably LARGER than the host's
# display area: hosts downsample a big source cleanly (heavy averaging hides
# scaling bias -> smooth), but upsampling a small source blurs it, biases one
# side, and can leave a stray corner pixel. The softness vs. the directly-drawn
# XEmbed icon is the host's own scaling filter and is not avoidable here.
SNI_ICON_SIZE = 128


def sni_watcher_present() -> bool:
    """Return True if a usable StatusNotifierWatcher is on the session bus.

    "Usable" means the watcher exists *and* reports a registered host; a
    watcher with no host accepts items but renders nothing, so in that case
    the caller should prefer the XEmbed fallback instead.
    """

    async def _check() -> bool:
        bus = await MessageBus(bus_type=BusType.SESSION).connect()
        try:
            introspection = await bus.introspect(
                "org.freedesktop.DBus", "/org/freedesktop/DBus"
            )
            proxy = bus.get_proxy_object(
                "org.freedesktop.DBus", "/org/freedesktop/DBus", introspection
            )
            dbus_iface = proxy.get_interface("org.freedesktop.DBus")
            if not await dbus_iface.call_name_has_owner(
                "org.kde.StatusNotifierWatcher"
            ):
                return False
            watcher_intro = await bus.introspect(
                "org.kde.StatusNotifierWatcher", "/StatusNotifierWatcher"
            )
            watcher_obj = bus.get_proxy_object(
                "org.kde.StatusNotifierWatcher",
                "/StatusNotifierWatcher",
                watcher_intro,
            )
            watcher = watcher_obj.get_interface(
                "org.kde.StatusNotifierWatcher"
            )
            try:
                return bool(
                    await watcher.get_is_status_notifier_host_registered()
                )
            except Exception:  # noqa: BLE001
                # Watcher lacks the property; assume a host exists.
                return True
        finally:
            bus.disconnect()

    try:
        return asyncio.run(_check())
    except Exception:  # noqa: BLE001
        logger.debug(
            "Could not query session bus for SNI watcher", exc_info=True
        )
        return False


def _argb_bytes(image: Image.Image) -> bytes:
    # The StatusNotifierItem spec wants ARGB32 in network (big-endian) byte
    # order, i.e. bytes laid out A, R, G, B per pixel. PIL's RGBA tobytes()
    # yields R, G, B, A, so reorder the channels before serialising.
    red, green, blue, alpha = image.split()
    return Image.merge("RGBA", (alpha, red, green, blue)).tobytes()


def _render_pixmaps(render_icon: "Callable[[int], Image.Image]") -> list[list]:
    # IconPixmap is an array of (width, height, bytes); we provide a single
    # square ARGB32 entry rendered natively at SNI_ICON_SIZE.
    image = render_icon(SNI_ICON_SIZE).convert("RGBA")
    return [[SNI_ICON_SIZE, SNI_ICON_SIZE, _argb_bytes(image)]]


class StatusNotifierItemInterface(ServiceInterface):
    def __init__(self, icon_pixmap: list, title: str, menu_path: str) -> None:
        super().__init__("org.kde.StatusNotifierItem")
        self._icon_pixmap = icon_pixmap
        self._title = title
        self._menu_path = menu_path
        self._on_activate: Callable[[], None] | None = None
        self._on_secondary: Callable[[], None] | None = None

    def update_icon(self, icon_pixmap: list) -> None:
        # Only signal on an actual change; the tray syncs state periodically
        # and re-emitting unchanged values makes hosts flicker the icon/tooltip.
        if icon_pixmap == self._icon_pixmap:
            return
        self._icon_pixmap = icon_pixmap
        self.NewIcon()

    def update_title(self, title: str) -> None:
        if title == self._title:
            return
        self._title = title
        self.NewTitle()
        # The tooltip text is derived from the title; hosts cache the ToolTip
        # property and only re-read it when NewToolTip fires.
        self.NewToolTip()

    @method()
    def Activate(self, x: "i", y: "i"):
        if self._on_activate:
            self._on_activate()

    @method()
    def SecondaryActivate(self, x: "i", y: "i"):
        if self._on_secondary:
            self._on_secondary()

    @method()
    def ContextMenu(self, x: "i", y: "i"):
        pass

    @dbus_property(access=PropertyAccess.READ)
    def Category(self) -> "s":
        return "ApplicationStatus"

    @dbus_property(access=PropertyAccess.READ)
    def Id(self) -> "s":
        return "gamepad-overlay"

    @dbus_property(access=PropertyAccess.READ)
    def Title(self) -> "s":
        return self._title

    @dbus_property(access=PropertyAccess.READ)
    def Status(self) -> "s":
        return "Active"

    @dbus_property(access=PropertyAccess.READ)
    def IconPixmap(self) -> "a(iiay)":
        return self._icon_pixmap

    @dbus_property(access=PropertyAccess.READ)
    def Menu(self) -> "o":
        return self._menu_path

    @dbus_property(access=PropertyAccess.READ)
    def ItemIsMenu(self) -> "b":
        return False

    # Hosts (snixembed, KDE, GNOME AppIndicator) query the full SNI property
    # set; missing properties raise UNKNOWN_PROPERTY and make the host reject
    # the item, so expose every spec property with empty/default values.
    @dbus_property(access=PropertyAccess.READ)
    def IconName(self) -> "s":
        return ""

    @dbus_property(access=PropertyAccess.READ)
    def IconThemePath(self) -> "s":
        return ""

    @dbus_property(access=PropertyAccess.READ)
    def OverlayIconName(self) -> "s":
        return ""

    @dbus_property(access=PropertyAccess.READ)
    def OverlayIconPixmap(self) -> "a(iiay)":
        return []

    @dbus_property(access=PropertyAccess.READ)
    def AttentionIconName(self) -> "s":
        return ""

    @dbus_property(access=PropertyAccess.READ)
    def AttentionIconPixmap(self) -> "a(iiay)":
        return []

    @dbus_property(access=PropertyAccess.READ)
    def AttentionMovieName(self) -> "s":
        return ""

    @dbus_property(access=PropertyAccess.READ)
    def WindowId(self) -> "i":
        return 0

    @dbus_property(access=PropertyAccess.READ)
    def ToolTip(self) -> "(sa(iiay)ss)":
        # (icon name, icon pixmap, title, description)
        return ["", [], self._title, ""]

    @dbus_signal()
    def NewIcon(self):
        pass

    @dbus_signal()
    def NewTitle(self):
        pass

    @dbus_signal()
    def NewToolTip(self):
        pass


class DBusMenuInterface(ServiceInterface):
    def __init__(
        self, items: list[tuple[int, str, Callable[[], None]]]
    ) -> None:
        super().__init__("com.canonical.dbusmenu")
        self._items = items
        self._revision = 0

    def _properties(self, item_id: int) -> dict[str, Variant]:
        for iid, label, _ in self._items:
            if iid == item_id:
                return {
                    "label": Variant("s", label),
                    "enabled": Variant("b", True),
                    "visible": Variant("b", True),
                }
        return {}

    @method()
    def GetLayout(
        self, parent_id: "i", recursion_depth: "i", property_names: "as"
    ) -> "u(ia{sv}av)":
        # Two out-args (revision: u, layout: (ia{sv}av)); a single wrapping
        # struct "(u(ia{sv}av))" would add an extra nesting layer that
        # libdbusmenu rejects.
        children: list[Variant] = []
        for item_id, label, _ in self._items:
            props = {
                "label": Variant("s", label),
                "enabled": Variant("b", True),
                "visible": Variant("b", True),
            }
            children.append(Variant("(ia{sv}av)", [item_id, props, []]))
        return [self._revision, [0, {}, children]]

    @method()
    def GetGroupProperties(
        self, ids: "ai", property_names: "as"
    ) -> "a(ia{sv})":
        ids_set = set(ids)
        return [
            [item_id, self._properties(item_id)]
            for item_id, _, _ in self._items
            if item_id in ids_set
        ]

    @method()
    def Event(self, menu_id: "i", event_id: "s", data: "v", timestamp: "u"):
        # The canonical dbusmenu Event signature is (id, eventId, data,
        # timestamp) -> "isvu"; libdbusmenu looks the method up by signature.
        if event_id == "clicked":
            for item_id, _, callback in self._items:
                if item_id == menu_id:
                    callback()
                    break

    @method()
    def GetProperty(self, menu_id: "i", name: "s") -> "v":
        props = self._properties(menu_id)
        return props.get(name, Variant("s", ""))

    @method()
    def AboutToShow(self, menu_id: "i") -> "b":
        # The menu is static, so nothing needs updating before it is shown.
        return False

    @method()
    def AboutToShowGroup(self, ids: "ai") -> "aiai":
        return [[], []]


class SNITrayIcon:
    def __init__(
        self,
        title: str,
        render_icon: "Callable[[int], Image.Image]",
        *,
        on_activate: Callable[[], None] | None = None,
        on_secondary: Callable[[], None] | None = None,
        on_quit: Callable[[], None] | None = None,
    ) -> None:
        self._title = title
        self._render_icon = render_icon
        self._on_activate = on_activate
        self._on_secondary = on_secondary
        self._on_quit = on_quit
        self._sni: StatusNotifierItemInterface | None = None
        self._dbus_menu: DBusMenuInterface | None = None
        self._bus: MessageBus | None = None
        self._stop_future: asyncio.Future[None] | None = None
        self._setup_callback: Callable[[object], None] | None = None
        # Strong references to fire-and-forget re-registration tasks so the
        # event loop does not garbage-collect them mid-flight.
        self._pending_tasks: set[asyncio.Task[bool]] = set()

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
        if self._sni is not None:
            self._sni.update_title(value)

    def set_icon(self, render_icon: "Callable[[int], Image.Image]") -> None:
        self._render_icon = render_icon
        if self._sni is not None:
            self._sni.update_icon(_render_pixmaps(render_icon))

    def stop(self) -> None:
        if self._stop_future is not None and not self._stop_future.done():
            loop = self._stop_future.get_loop()
            loop.call_soon_threadsafe(self._stop_future.set_result, None)

    def run(self, setup: Callable[[object], None] | None = None) -> None:
        self._setup_callback = setup
        asyncio.run(self._async_run())

    async def _watch_for_watcher(self) -> None:
        """Re-register if a StatusNotifierWatcher appears (or restarts).

        On minimal setups the watcher (e.g. ``snixembed``) may be started
        after this app, so registering once at startup is not enough.
        """
        if self._bus is None:
            return
        try:
            introspection = await self._bus.introspect(
                "org.freedesktop.DBus", "/org/freedesktop/DBus"
            )
            proxy = self._bus.get_proxy_object(
                "org.freedesktop.DBus", "/org/freedesktop/DBus", introspection
            )
            dbus_iface = proxy.get_interface("org.freedesktop.DBus")

            def _on_name_owner_changed(
                name: str, _old_owner: str, new_owner: str
            ) -> None:
                if name == "org.kde.StatusNotifierWatcher" and new_owner:
                    task = asyncio.ensure_future(self._register_with_watcher())
                    self._pending_tasks.add(task)
                    task.add_done_callback(self._pending_tasks.discard)

            dbus_iface.on_name_owner_changed(_on_name_owner_changed)
        except Exception:  # noqa: BLE001
            logger.debug(
                "Could not subscribe to NameOwnerChanged", exc_info=True
            )

    async def _register_with_watcher(self) -> bool:
        if self._bus is None:
            return False
        try:
            introspection = await self._bus.introspect(
                "org.kde.StatusNotifierWatcher", "/StatusNotifierWatcher"
            )
            proxy = self._bus.get_proxy_object(
                "org.kde.StatusNotifierWatcher",
                "/StatusNotifierWatcher",
                introspection,
            )
            watcher = proxy.get_interface("org.kde.StatusNotifierWatcher")
            # dbus-next exposes D-Bus methods in snake_case with a call_ prefix.
            await watcher.call_register_status_notifier_item(
                self._bus.unique_name
            )
            logger.info("Registered with StatusNotifierWatcher")
        except Exception:  # noqa: BLE001
            logger.debug(
                "Could not register with StatusNotifierWatcher", exc_info=True
            )
            return False
        return True

    async def _async_run(self) -> None:
        loop = asyncio.get_running_loop()

        def _signal_stop() -> None:
            if self._stop_future is not None and not self._stop_future.done():
                self._stop_future.set_result(None)

        for sig in (_signal.SIGINT, _signal.SIGTERM):
            # Not supported on this platform, or not on the main thread.
            with contextlib.suppress(NotImplementedError, RuntimeError):
                loop.add_signal_handler(sig, _signal_stop)

        self._bus = MessageBus(bus_type=BusType.SESSION)
        await self._bus.connect()

        pixmap = _render_pixmaps(self._render_icon)

        dbus_items: list[tuple[int, str, Callable[[], None]]] = []
        if self._on_activate is not None:
            dbus_items.append((1, "Configure...", self._on_activate))
        if self._on_quit is not None:
            dbus_items.append((2, "Quit", self._on_quit))

        self._dbus_menu = DBusMenuInterface(dbus_items)
        self._bus.export(DBUS_MENU_OBJECT_PATH, self._dbus_menu)

        self._sni = StatusNotifierItemInterface(
            pixmap, self._title, DBUS_MENU_OBJECT_PATH
        )
        self._sni._on_activate = self._on_activate
        self._sni._on_secondary = self._on_secondary
        self._bus.export(SNI_OBJECT_PATH, self._sni)

        if not await self._register_with_watcher():
            # No usable watcher at startup. Abort so the caller can fall back
            # to a backend that does not need an SNI host (e.g. XEmbed).
            self._bus.disconnect()
            msg = "No StatusNotifierWatcher available"
            raise SNIRegistrationError(msg)
        await self._watch_for_watcher()

        if self._setup_callback is not None:
            self._setup_callback(self)

        self._stop_future = loop.create_future()
        await self._stop_future

        self._bus.disconnect()

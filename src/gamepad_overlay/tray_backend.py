"""Cross-platform tray-icon abstraction.

The application talks to a single :class:`TrayIcon` interface; :func:`create_tray_icon`
hides which backend implements it:

* Windows/macOS -> pystray.
* Linux -> StatusNotifierItem when a usable SNI host is present (KDE/GNOME,
  Wayland, or fluxbox with snixembed), otherwise the self-contained XEmbed
  backend. The Linux wrapper also transparently falls back from SNI to XEmbed
  if SNI registration fails at startup.
"""

from __future__ import annotations

import logging
import sys
from typing import TYPE_CHECKING, Protocol

if TYPE_CHECKING:
    from collections.abc import Callable

    from PIL import Image

    # Draws the tray icon natively at a requested square pixel size.
    IconRenderer = Callable[[int], Image.Image]
    # Invoked once the tray event loop is ready.
    SetupCallback = Callable[[object], None]

logger = logging.getLogger(__name__)


class SNIRegistrationError(RuntimeError):
    """Raised when the SNI backend cannot register with a watcher at startup.

    Signals the Linux wrapper to fall back to the XEmbed backend, which needs
    no StatusNotifierItem host. Handled internally by :class:`_LinuxTrayIcon`.
    """


class TrayIcon(Protocol):
    """The tray-icon surface the application relies on, regardless of backend."""

    title: str
    visible: bool

    def set_icon(self, render_icon: IconRenderer) -> None:
        """Replace the icon; ``render_icon(size)`` draws it at the host size."""

    def run(self, setup: SetupCallback | None = None) -> None:
        """Run the tray event loop, calling ``setup`` once it is ready."""

    def stop(self) -> None:
        """Stop the tray event loop."""


class _PystrayIcon:
    """Adapt :class:`pystray.Icon` to :class:`TrayIcon` (Windows/macOS)."""

    _ICON_SIZE = 64

    def __init__(
        self,
        name: str,
        title: str,
        render_icon: IconRenderer,
        *,
        on_activate: Callable[[], None],
        on_quit: Callable[[], None],
    ) -> None:
        import pystray

        menu = pystray.Menu(
            pystray.MenuItem(
                "Configure...", lambda _i, _it: on_activate(), default=True
            ),
            pystray.MenuItem("Quit", lambda _i, _it: on_quit()),
        )
        self._icon = pystray.Icon(
            name, icon=render_icon(self._ICON_SIZE), title=title, menu=menu
        )

    def set_icon(self, render_icon: IconRenderer) -> None:
        self._icon.icon = render_icon(self._ICON_SIZE)

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

    def run(self, setup: SetupCallback | None = None) -> None:
        self._icon.run(setup=setup)

    def stop(self) -> None:
        self._icon.stop()


class _LinuxTrayIcon:
    """The Linux tray: StatusNotifierItem with a transparent XEmbed fallback.

    Tracks the current title/renderer so that, if SNI registration fails and we
    rebuild on the XEmbed backend, the rebuilt icon reflects the latest state.
    """

    def __init__(
        self,
        name: str,
        title: str,
        render_icon: IconRenderer,
        *,
        on_activate: Callable[[], None],
        on_quit: Callable[[], None],
    ) -> None:
        self._name = name
        self._title = title
        self._render_icon = render_icon
        self._on_activate = on_activate
        self._on_quit = on_quit
        self._backend: TrayIcon = self._make_backend()

    def _make_backend(self, *, force_xembed: bool = False) -> TrayIcon:
        if not force_xembed:
            from .tray_sni import SNITrayIcon, sni_watcher_present

            if sni_watcher_present():
                return SNITrayIcon(
                    self._title,
                    self._render_icon,
                    on_activate=self._on_activate,
                    on_secondary=self._on_activate,
                    on_quit=self._on_quit,
                )

        from .tray_xembed import XEmbedTrayIcon

        return XEmbedTrayIcon(
            self._name,
            self._title,
            self._render_icon,
            on_activate=self._on_activate,
            on_quit=self._on_quit,
        )

    def set_icon(self, render_icon: IconRenderer) -> None:
        self._render_icon = render_icon
        self._backend.set_icon(render_icon)

    @property
    def title(self) -> str:
        return self._backend.title

    @title.setter
    def title(self, value: str) -> None:
        self._title = value
        self._backend.title = value

    @property
    def visible(self) -> bool:
        return self._backend.visible

    @visible.setter
    def visible(self, value: bool) -> None:
        self._backend.visible = value

    def run(self, setup: SetupCallback | None = None) -> None:
        try:
            self._backend.run(setup)
        except SNIRegistrationError:
            logger.warning(
                "StatusNotifierItem registration failed; "
                "falling back to the XEmbed tray icon"
            )
            self._backend = self._make_backend(force_xembed=True)
            self._backend.run(setup)

    def stop(self) -> None:
        self._backend.stop()


def create_tray_icon(
    name: str,
    title: str,
    render_icon: IconRenderer,
    *,
    on_activate: Callable[[], None],
    on_quit: Callable[[], None],
) -> TrayIcon:
    """Create the platform-appropriate tray icon behind :class:`TrayIcon`.

    ``on_activate`` is the default action (left-click / Configure...) and
    ``on_quit`` is the Quit action.
    """
    if sys.platform in ("win32", "darwin"):
        return _PystrayIcon(
            name, title, render_icon, on_activate=on_activate, on_quit=on_quit
        )
    return _LinuxTrayIcon(
        name, title, render_icon, on_activate=on_activate, on_quit=on_quit
    )

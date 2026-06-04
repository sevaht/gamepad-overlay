from __future__ import annotations

import logging
import signal
import sys
from dataclasses import dataclass, field
from threading import Event, Thread
from typing import TYPE_CHECKING, Protocol, override

from PySide6 import QtCore, QtGui, QtWidgets
from PySide6.QtCore import QTimer
from PySide6.QtWidgets import QApplication

from .application import (
    SDLGameController,
    ServerRunConfig,
    _clear_selected_controller,
    _controller_config_path,
    _controller_metadata_summary,
    _load_selected_controller,
    _save_selected_controller,
    run_server,
)

logger = logging.getLogger(__name__)

CONTROLLER_NAME_ROLE = int(QtCore.Qt.ItemDataRole.UserRole) + 1
CONTROLLER_DETAIL_ROLE = int(QtCore.Qt.ItemDataRole.UserRole) + 2
CONTROLLER_BADGES_ROLE = int(QtCore.Qt.ItemDataRole.UserRole) + 3
CONTROLLER_ROW_HORIZONTAL_PADDING = 8
CONTROLLER_ROW_VERTICAL_PADDING = 6
CONTROLLER_ROW_LINE_GAP = 2
CONTROLLER_NAME_POINT_SIZE_INCREMENT = 2
CONTROLLER_BADGE_GAP = 6
ACTIVE_CONTROLLER_BADGE = "★"
SELECTED_CONTROLLER_BADGE = "Selected"
ICON_BUTTON_SIZE = 24
ICON_BUTTON_STROKE_WIDTH = 3.0
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
TRAY_ICONS: dict[bool, QIcon] = {}

if TYPE_CHECKING:
    from collections.abc import Callable
    from pathlib import Path

    from PySide6.QtCore import QEvent
    from PySide6.QtGui import QCloseEvent, QIcon


class ServerBackend(Protocol):
    def ensure_started(self) -> None: ...

    def status_label(self) -> str: ...

    def is_controller_connected(self) -> bool: ...

    def client_count(self) -> int: ...

    def active_controller(self) -> dict[str, object] | None: ...

    def stop(self) -> None: ...


class BackendSignals(QtCore.QObject):
    controllers_changed = QtCore.Signal()
    active_controller_changed = QtCore.Signal(object)
    client_count_changed = QtCore.Signal(int)


@dataclass
class ManagedServerBackend:
    config_path: Path
    lan: bool = False
    terminal: bool = False
    device_change_callback: Callable[[], None] | None = None
    active_controller_callback: (
        Callable[[dict[str, object] | None], None] | None
    ) = None
    client_count_callback: Callable[[int], None] | None = None
    thread: Thread | None = field(default=None, init=False)
    stop_event: Event = field(default_factory=Event, init=False)
    failed: bool = field(default=False, init=False)
    active_controller_info: dict[str, object] | None = field(
        default=None, init=False
    )
    connected_client_count: int = field(default=0, init=False)

    def ensure_started(self) -> None:
        if self.thread is not None and self.thread.is_alive():
            return
        self.failed = False
        self.stop_event.clear()
        self.thread = Thread(
            target=self._run_server,
            name="gamepad-websocket-server",
            daemon=True,
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
                    active_controller_callback=self.active_controller_callback,
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

    def is_controller_connected(self) -> bool:
        return self.active_controller_info is not None

    def client_count(self) -> int:
        return self.connected_client_count

    def active_controller(self) -> dict[str, object] | None:
        return self.active_controller_info

    def stop(self) -> None:
        self.stop_event.set()
        if self.thread is not None:
            self.thread.join(timeout=0.2)
        self.active_controller_info = None
        self.connected_client_count = 0


def _status_text(*, attached: bool, client_count: int) -> str:
    state = "Attached" if attached else "Detached"
    client_label = "Client" if client_count == 1 else "Clients"
    return (
        f"Gamepad Server - {state} "
        f"({client_count} {client_label} Connected)"
    )


def _controller_matches_selection(
    controller: dict[str, object], selected: dict[str, str] | None
) -> bool:
    return SDLGameController._matches_selected_controller(controller, selected)


def _controller_selection_identity(
    controller: dict[str, object],
) -> dict[str, str]:
    return {
        field_name: str(controller.get(field_name, "")).strip()
        for field_name in ("guid", "vendor", "product", "name")
    }


def _controller_identity_hint(controller: dict[str, object]) -> str:
    metadata = _controller_metadata_summary(controller, version_first=True)
    return metadata or "No stable identifier exposed"


def _controller_display_names(
    controllers: list[dict[str, object]],
) -> list[str]:
    names = [
        str(controller.get("name", "unknown")) for controller in controllers
    ]
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


def _controller_row_label(
    controller: dict[str, object], display_name: str
) -> str:
    return f"{display_name}\n{_controller_identity_hint(controller)}"


def _controller_row_badges(
    controller: dict[str, object],
    selected: dict[str, str] | None,
    active_controller: dict[str, object] | None,
) -> tuple[str, ...]:
    badges: list[str] = []
    if active_controller is not None and _controller_matches_selection(
        controller, _controller_selection_identity(active_controller)
    ):
        badges.append(ACTIVE_CONTROLLER_BADGE)
    if selected is not None and _controller_matches_selection(
        controller, selected
    ):
        badges.append(SELECTED_CONTROLLER_BADGE)
    return tuple(badges)


def _controller_name_font(base_font: QtGui.QFont) -> QtGui.QFont:
    font = QtGui.QFont(base_font)
    font.setBold(True)
    font.setPointSize(font.pointSize() + CONTROLLER_NAME_POINT_SIZE_INCREMENT)
    return font


def _controller_detail_font(base_font: QtGui.QFont) -> QtGui.QFont:
    font = QtGui.QFont(base_font)
    font.setBold(False)
    return font


def _controller_row_height(base_font: QtGui.QFont) -> int:
    name_height = QtGui.QFontMetrics(_controller_name_font(base_font)).height()
    detail_height = QtGui.QFontMetrics(
        _controller_detail_font(base_font)
    ).height()
    return (
        CONTROLLER_ROW_VERTICAL_PADDING
        + name_height
        + CONTROLLER_ROW_LINE_GAP
        + detail_height
        + CONTROLLER_ROW_VERTICAL_PADDING
    )


class ControllerItemDelegate(QtWidgets.QStyledItemDelegate):
    @override
    def paint(
        self,
        painter: QtGui.QPainter,
        option: QtWidgets.QStyleOptionViewItem,
        index: QtCore.QModelIndex | QtCore.QPersistentModelIndex,
    ) -> None:
        item_option = QtWidgets.QStyleOptionViewItem(option)
        self.initStyleOption(item_option, index)
        item_option.text = ""

        widget = item_option.widget
        style = (
            widget.style()
            if widget is not None
            else QtWidgets.QApplication.style()
        )
        style.drawControl(
            QtWidgets.QStyle.ControlElement.CE_ItemViewItem,
            item_option,
            painter,
            widget,
        )

        name = str(index.data(CONTROLLER_NAME_ROLE) or "")
        detail = str(index.data(CONTROLLER_DETAIL_ROLE) or "")
        badges = tuple(
            str(badge) for badge in (index.data(CONTROLLER_BADGES_ROLE) or ())
        )
        text_rect = item_option.rect.adjusted(
            CONTROLLER_ROW_HORIZONTAL_PADDING,
            CONTROLLER_ROW_VERTICAL_PADDING,
            -CONTROLLER_ROW_HORIZONTAL_PADDING,
            -CONTROLLER_ROW_VERTICAL_PADDING,
        )

        painter.save()
        text_role = QtGui.QPalette.ColorRole.Text
        if item_option.state & QtWidgets.QStyle.StateFlag.State_Selected:
            text_role = QtGui.QPalette.ColorRole.HighlightedText
        painter.setPen(
            item_option.palette.color(
                item_option.palette.currentColorGroup(), text_role
            )
        )

        name_font = _controller_name_font(item_option.font)
        name_metrics = QtGui.QFontMetrics(name_font)
        detail_font = _controller_detail_font(item_option.font)
        detail_metrics = QtGui.QFontMetrics(detail_font)

        # Separate badges: star (active) on left, text (selected) on right
        left_badges = [b for b in badges if b == ACTIVE_CONTROLLER_BADGE]
        right_badges = [b for b in badges if b == SELECTED_CONTROLLER_BADGE]

        left_badge_width = sum(
            detail_metrics.horizontalAdvance(b) for b in left_badges
        )
        right_badge_width = sum(
            name_metrics.horizontalAdvance(b) for b in right_badges
        )
        right_badge_width += CONTROLLER_BADGE_GAP * max(
            0, len(right_badges) - 1
        )

        name_left = text_rect.left() + (
            left_badge_width + CONTROLLER_BADGE_GAP if left_badges else 0
        )
        name_right = text_rect.right() - (
            right_badge_width + CONTROLLER_BADGE_GAP if right_badges else 0
        )

        name_rect = QtCore.QRect(
            name_left,
            text_rect.top(),
            max(0, name_right - name_left),
            name_metrics.height(),
        )

        if left_badges:
            painter.setFont(detail_font)
            badge_x = text_rect.left()
            for badge in left_badges:
                width = detail_metrics.horizontalAdvance(badge)
                badge_rect = QtCore.QRect(
                    badge_x, name_rect.top(), width, name_rect.height()
                )
                painter.drawText(
                    badge_rect, QtCore.Qt.AlignmentFlag.AlignCenter, badge
                )
                badge_x += width + CONTROLLER_BADGE_GAP

        painter.setFont(name_font)
        elided_name = name_metrics.elidedText(
            name, QtCore.Qt.TextElideMode.ElideRight, name_rect.width()
        )
        painter.drawText(
            name_rect,
            QtCore.Qt.AlignmentFlag.AlignLeft
            | QtCore.Qt.AlignmentFlag.AlignVCenter,
            elided_name,
        )

        if right_badges:
            badge_x = text_rect.right() - right_badge_width + 1
            for badge in right_badges:
                width = name_metrics.horizontalAdvance(badge)
                badge_rect = QtCore.QRect(
                    badge_x, name_rect.top(), width, name_rect.height()
                )
                painter.drawText(
                    badge_rect, QtCore.Qt.AlignmentFlag.AlignCenter, badge
                )
                badge_x += width + CONTROLLER_BADGE_GAP

        painter.setFont(detail_font)
        detail_rect = QtCore.QRect(
            text_rect.left(),
            name_rect.bottom() + CONTROLLER_ROW_LINE_GAP,
            text_rect.width(),
            detail_metrics.height(),
        )
        elided_detail = detail_metrics.elidedText(
            detail, QtCore.Qt.TextElideMode.ElideLeft, detail_rect.width()
        )
        painter.drawText(
            detail_rect,
            QtCore.Qt.AlignmentFlag.AlignRight
            | QtCore.Qt.AlignmentFlag.AlignVCenter,
            elided_detail,
        )
        painter.restore()

    @override
    def sizeHint(
        self,
        option: QtWidgets.QStyleOptionViewItem,
        index: QtCore.QModelIndex | QtCore.QPersistentModelIndex,
    ) -> QtCore.QSize:
        size = super().sizeHint(option, index)
        size.setHeight(_controller_row_height(option.font))
        return size


def _selected_controller_index(
    controllers: list[dict[str, object]], selected: dict[str, str] | None
) -> int | None:
    if selected is None:
        return None
    for index, controller in enumerate(controllers):
        if _controller_matches_selection(controller, selected):
            return index
    return None


def _new_icon_pixmap() -> QtGui.QPixmap:
    pixmap = QtGui.QPixmap(64, 64)
    pixmap.fill(QtCore.Qt.GlobalColor.transparent)
    return pixmap


def _new_icon_painter(pixmap: QtGui.QPixmap) -> QtGui.QPainter:
    painter = QtGui.QPainter(pixmap)
    painter.setRenderHint(QtGui.QPainter.RenderHint.Antialiasing)
    return painter


def _draw_outlined_ellipse(
    painter: QtGui.QPainter,
    rect: QtCore.QRectF,
    fill: QtGui.QColor,
    *,
    stroke_width: float = ICON_BUTTON_STROKE_WIDTH,
) -> None:
    painter.setPen(QtGui.QPen(QtGui.QColor(0, 0, 0, 255), stroke_width))
    painter.setBrush(fill)
    painter.drawEllipse(rect)


def _qcolor(rgb: tuple[int, int, int]) -> QtGui.QColor:
    red, green, blue = rgb
    return QtGui.QColor(red, green, blue, 255)


def _create_face_buttons_icon(*, connected: bool) -> QIcon:
    pixmap = _new_icon_pixmap()
    painter = _new_icon_painter(pixmap)

    colors = (
        XBOX_FACE_BUTTON_PRESSED_COLORS
        if connected
        else XBOX_FACE_BUTTON_RELEASED_COLORS
    )
    for button_name, (center_x, center_y) in ICON_BUTTON_CENTERS.items():
        _draw_outlined_ellipse(
            painter,
            QtCore.QRectF(
                center_x - ICON_BUTTON_SIZE / 2,
                center_y - ICON_BUTTON_SIZE / 2,
                ICON_BUTTON_SIZE,
                ICON_BUTTON_SIZE,
            ),
            _qcolor(colors[button_name]),
        )

    painter.end()
    return QtGui.QIcon(pixmap)


def _create_tray_icon(*, connected: bool = False) -> QIcon:
    icon = TRAY_ICONS.get(connected)
    if icon is None:
        icon = _create_face_buttons_icon(connected=connected)
        TRAY_ICONS[connected] = icon
    return icon


def _list_available_controllers() -> list[dict[str, object]]:
    return SDLGameController.list_available_controllers()


class ControllerSelectorWindow:
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
        self.controllers: list[dict[str, object]] = []
        self.icon_connected: bool | None = None

        owner = self

        class _Window(QtWidgets.QWidget):
            def closeEvent(self, event: QCloseEvent) -> None:  # noqa: N802
                owner._handle_close_event(event)

            def changeEvent(self, event: QEvent) -> None:  # noqa: N802
                super().changeEvent(event)
                owner._handle_change_event(event)

        self.widget = _Window()
        self._update_connection_state()
        self.widget.resize(640, 460)
        self.widget.setMinimumSize(520, 380)

        layout = QtWidgets.QVBoxLayout(self.widget)
        layout.setContentsMargins(18, 18, 18, 18)
        layout.setSpacing(12)

        self._build_controller_list(layout)
        self._build_buttons(layout)

        self.refresh()

    def _build_controller_list(self, layout: QtWidgets.QVBoxLayout) -> None:
        self.controller_list = QtWidgets.QListWidget()
        self.controller_list.setObjectName("controllerList")
        self.controller_list.setSpacing(2)
        self.controller_list.setWordWrap(True)
        self.controller_list.setItemDelegate(
            ControllerItemDelegate(self.controller_list)
        )
        self.controller_list.itemSelectionChanged.connect(
            self._handle_controller_selection_changed
        )
        self.controller_list.itemDoubleClicked.connect(
            lambda _item: self.select_current_controller()
        )
        layout.addWidget(self.controller_list, stretch=1)

    def _build_buttons(self, layout: QtWidgets.QVBoxLayout) -> None:
        button_row = QtWidgets.QHBoxLayout()
        button_row.setSpacing(8)
        layout.addLayout(button_row)

        self.select_button = QtWidgets.QPushButton("Select Gamepad")
        self.select_button.clicked.connect(self.select_current_controller)
        button_row.addWidget(self.select_button)

        use_any_button = QtWidgets.QPushButton("Use Any Gamepad")
        use_any_button.clicked.connect(self.use_any_controller)
        button_row.addWidget(use_any_button)

        refresh_button = QtWidgets.QPushButton("Refresh")
        refresh_button.clicked.connect(self.refresh)
        button_row.addWidget(refresh_button)

        button_row.addStretch(1)

        if self.hide_on_close:
            hide_button = QtWidgets.QPushButton("Hide")
            hide_button.clicked.connect(self._dismiss)
            button_row.addWidget(hide_button)

        close_button = QtWidgets.QPushButton(
            "Quit" if self.hide_on_close else "Close"
        )
        close_button.clicked.connect(
            self._request_quit if self.hide_on_close else self.widget.close
        )
        button_row.addWidget(close_button)

    def _dismiss(self) -> None:
        if self.hide_on_close:
            self.widget.hide()
            return
        self.widget.close()

    def _update_select_button_state(self) -> None:
        selected_row = self.controller_list.currentRow()
        self.select_button.setEnabled(
            0 <= selected_row < len(self.controllers)
        )

    def _handle_controller_selection_changed(self) -> None:
        self._update_select_button_state()

    def _add_disabled_controller_row(self, text: str) -> None:
        item = QtWidgets.QListWidgetItem(text)
        item.setData(CONTROLLER_NAME_ROLE, text)
        item.setData(CONTROLLER_DETAIL_ROLE, "")
        item.setFlags(item.flags() & ~QtCore.Qt.ItemFlag.ItemIsEnabled)
        self.controller_list.addItem(item)

    def _update_connection_state(self) -> None:
        attached = (
            self.server_backend.is_controller_connected()
            if self.server_backend is not None
            else False
        )
        client_count = (
            self.server_backend.client_count()
            if self.server_backend is not None
            else 0
        )
        self.widget.setWindowTitle(
            _status_text(attached=attached, client_count=client_count)
        )
        if attached == self.icon_connected:
            return
        self.icon_connected = attached
        self.widget.setWindowIcon(_create_tray_icon(connected=attached))

    def _handle_close_event(self, event: QCloseEvent) -> None:
        event.accept()

    def _handle_change_event(self, event: object) -> None:
        event_type = getattr(event, "type", lambda: None)()
        if event_type != QtCore.QEvent.Type.WindowStateChange:
            return
        if self.hide_on_close and self.widget.isMinimized():
            QtCore.QTimer.singleShot(0, self.widget.close)

    def _request_quit(self) -> None:
        if self.quit_callback is not None:
            self.quit_callback()

    def show(self) -> None:
        self.refresh()
        restored_state = (
            self.widget.windowState()
            & ~QtCore.Qt.WindowState.WindowMinimized
            & ~QtCore.Qt.WindowState.WindowMaximized
        )
        self.widget.setWindowState(
            restored_state | QtCore.Qt.WindowState.WindowActive
        )
        self.widget.show()
        self.widget.raise_()
        self.widget.activateWindow()

    def is_visible(self) -> bool:
        return self.widget.isVisible()

    def refresh(self) -> None:
        if self.server_backend is not None:
            self.server_backend.ensure_started()

        previous_row = self.controller_list.currentRow()

        self.controller_list.clear()
        try:
            self.controllers = _list_available_controllers()
        except RuntimeError as exc:
            logger.exception("Failed to refresh controllers")
            self.controllers = []
            self._update_connection_state()
            self._add_disabled_controller_row(str(exc))
            self.select_button.setEnabled(False)
            return

        selected = _load_selected_controller(self.config_path)
        active_controller = (
            self.server_backend.active_controller()
            if self.server_backend is not None
            else None
        )
        self._update_connection_state()

        if not self.controllers:
            self._add_disabled_controller_row("No gamepads found")
            self._update_select_button_state()
            return

        selected_row = _selected_controller_index(self.controllers, selected)
        display_names = _controller_display_names(self.controllers)
        for controller, display_name in zip(
            self.controllers, display_names, strict=True
        ):
            row_label = _controller_row_label(controller, display_name)
            item = QtWidgets.QListWidgetItem(row_label)
            item.setData(CONTROLLER_NAME_ROLE, row_label.split("\n", 1)[0])
            item.setData(
                CONTROLLER_DETAIL_ROLE, _controller_identity_hint(controller)
            )
            item.setData(
                CONTROLLER_BADGES_ROLE,
                _controller_row_badges(
                    controller, selected, active_controller
                ),
            )
            self.controller_list.addItem(item)

        if selected_row is not None:
            self.controller_list.setCurrentRow(selected_row)
        elif previous_row >= 0 and previous_row < len(self.controllers):
            self.controller_list.setCurrentRow(previous_row)
        self._update_select_button_state()

    def select_current_controller(self) -> None:
        selected_row = self.controller_list.currentRow()
        if not 0 <= selected_row < len(self.controllers):
            return
        _save_selected_controller(
            self.config_path, self.controllers[selected_row]
        )
        self.refresh()
        if self.selection_changed_callback is not None:
            self.selection_changed_callback()

    def use_any_controller(self) -> None:
        _clear_selected_controller(self.config_path)
        self.refresh()
        if self.selection_changed_callback is not None:
            self.selection_changed_callback()


class ControllerSelectorTray:
    def __init__(
        self,
        config_path: Path | None = None,
        *,
        lan: bool = False,
        terminal: bool = False,
    ) -> None:
        self.config_path = config_path or _controller_config_path()
        self.signals = BackendSignals()
        self.signals.controllers_changed.connect(self._refresh_from_backend)
        self.signals.active_controller_changed.connect(
            self._handle_active_controller_changed
        )
        self.signals.client_count_changed.connect(
            self._handle_client_count_changed
        )
        self.server_backend = ManagedServerBackend(
            config_path=self.config_path,
            lan=lan,
            terminal=terminal,
            device_change_callback=self.signals.controllers_changed.emit,
            active_controller_callback=self.signals.active_controller_changed.emit,
            client_count_callback=self.signals.client_count_changed.emit,
        )
        self.server_backend.ensure_started()

        self.window = ControllerSelectorWindow(
            self.config_path,
            server_backend=self.server_backend,
            hide_on_close=True,
            quit_callback=self._request_quit,
            selection_changed_callback=self._sync_connection_state,
        )

        self.tray = QtWidgets.QSystemTrayIcon(_create_tray_icon())
        self.tray_icon_connected: bool | None = False
        self._sync_connection_state()
        self.menu = QtWidgets.QMenu()
        self.menu.aboutToShow.connect(self.rebuild_menu)
        self.tray.setContextMenu(self.menu)
        self.tray.activated.connect(self._handle_activation)

    def _handle_activation(self, reason: object) -> None:
        activation_reason = QtWidgets.QSystemTrayIcon.ActivationReason
        if reason in {
            activation_reason.Trigger,
            activation_reason.DoubleClick,
        }:
            self.window.show()

    def rebuild_menu(self) -> None:
        self.server_backend.ensure_started()
        self.menu.clear()
        self._sync_connection_state()

        configure_action = self.menu.addAction("Configure...")
        configure_action.triggered.connect(self.window.show)

        quit_action = self.menu.addAction("Quit")
        quit_action.triggered.connect(self._request_quit)

    def _refresh_from_backend(self) -> None:
        self.window.refresh()
        self.rebuild_menu()

    def _handle_active_controller_changed(
        self, active_controller: object
    ) -> None:
        self.server_backend.active_controller_info = (
            active_controller if isinstance(active_controller, dict) else None
        )
        self.window.refresh()
        self._sync_connection_state()

    def _handle_client_count_changed(self, client_count: int) -> None:
        self.server_backend.connected_client_count = client_count
        self._sync_connection_state()

    def _sync_connection_state(self) -> None:
        self.window._update_connection_state()
        self._update_tray_state()

    def _update_tray_tooltip(self) -> None:
        self.tray.setToolTip(
            _status_text(
                attached=self.server_backend.is_controller_connected(),
                client_count=self.server_backend.client_count(),
            )
        )

    def _update_tray_state(self) -> None:
        connected = self.server_backend.is_controller_connected()
        self._update_tray_tooltip()
        if connected == self.tray_icon_connected:
            return
        self.tray_icon_connected = connected
        self.tray.setIcon(_create_tray_icon(connected=connected))

    def _request_quit(self) -> None:
        button = QtWidgets.QMessageBox.question(
            self.window.widget,
            "Quit Gamepad Server",
            "Quit the tray and stop the managed gamepad server?",
            QtWidgets.QMessageBox.StandardButton.Yes
            | QtWidgets.QMessageBox.StandardButton.No,
            QtWidgets.QMessageBox.StandardButton.No,
        )
        if button == QtWidgets.QMessageBox.StandardButton.Yes:
            self._quit()

    def _quit(self) -> None:
        self.server_backend.stop()
        self.tray.hide()
        app = QApplication.instance()
        if app is not None:
            app.quit()

    def run(self, *, start_hidden: bool = False) -> int:
        if not QtWidgets.QSystemTrayIcon.isSystemTrayAvailable():
            msg = "No system tray is available in this desktop session."
            raise RuntimeError(msg)

        app = QApplication.instance()
        if app is None:
            msg = "QApplication must exist before running the tray."
            raise RuntimeError(msg)
        if not isinstance(app, QApplication):
            msg = "A non-widget Qt application already exists."
            raise TypeError(msg)
        app.setQuitOnLastWindowClosed(False)

        self.rebuild_menu()
        self.tray.show()
        if not start_hidden:
            self.window.show()
        return int(app.exec())


def _create_application() -> QApplication:
    app = QApplication.instance()
    if app is None:
        app = QApplication([sys.argv[0]])
    elif not isinstance(app, QApplication):
        msg = "A non-widget Qt application already exists."
        raise TypeError(msg)
    app.setApplicationName("Gamepad Selector")
    app.setQuitOnLastWindowClosed(True)
    return app


def _install_signal_handlers(quit_callback: Callable[[], None]) -> QTimer:
    app = QApplication.instance()
    timer = QTimer(app)
    timer.timeout.connect(lambda: None)
    timer.start(100)

    def handle_signal(_signum: int, _frame: object | None) -> None:
        quit_callback()

    signal.signal(signal.SIGINT, handle_signal)
    if hasattr(signal, "SIGTERM"):
        signal.signal(signal.SIGTERM, handle_signal)
    return timer


def run_tray(
    *,
    config_path: Path | None = None,
    lan: bool = False,
    terminal: bool = False,
    start_hidden: bool = False,
) -> int:
    _create_application()
    tray = ControllerSelectorTray(config_path, lan=lan, terminal=terminal)
    signal_timer = _install_signal_handlers(tray._quit)
    try:
        return tray.run(start_hidden=start_hidden)
    finally:
        signal_timer.stop()

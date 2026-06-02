from __future__ import annotations

import argparse
import logging
import signal
import sys
from dataclasses import dataclass, field
from threading import Event, Thread
from typing import TYPE_CHECKING, Protocol

from PySide6 import QtCore, QtGui, QtWidgets
from PySide6.QtCore import QTimer
from PySide6.QtWidgets import QApplication

from .application import (
    SDLGameController,
    ServerRunConfig,
    _clear_selected_controller,
    _controller_config_path,
    _load_selected_controller,
    _save_selected_controller,
    run_server,
)

logger = logging.getLogger(__name__)

if TYPE_CHECKING:
    from collections.abc import Callable, Sequence
    from pathlib import Path

    from PySide6.QtCore import QEvent
    from PySide6.QtGui import QCloseEvent, QIcon


class ServerBackend(Protocol):
    def ensure_started(self) -> None: ...

    def status_label(self) -> str: ...

    def stop(self) -> None: ...


@dataclass
class ManagedServerBackend:
    config_path: Path
    lan: bool = False
    terminal: bool = False
    thread: Thread | None = field(default=None, init=False)
    stop_event: Event = field(default_factory=Event, init=False)
    failed: bool = field(default=False, init=False)

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

    def stop(self) -> None:
        self.stop_event.set()
        if self.thread is not None:
            self.thread.join(timeout=0.2)


def _current_selection_label(config_path: Path) -> str:
    selected = _load_selected_controller(config_path)
    if selected is None:
        return "Current: any controller"
    guid = selected.get("guid", "")
    name = selected.get("name", "")
    if guid:
        return f"Current: guid={guid}"
    if name:
        return f"Current: name~={name}"
    return "Current: any controller"


def _controller_matches_selection(
    controller: dict[str, object], selected: dict[str, str] | None
) -> bool:
    if selected is None:
        return False
    selected_guid = selected.get("guid", "")
    if selected_guid:
        return str(controller.get("guid", "")).strip() == selected_guid
    selected_name = selected.get("name", "").strip().lower()
    if selected_name:
        return selected_name in str(controller.get("name", "")).lower()
    return False


def _controller_menu_label(controller: dict[str, object]) -> str:
    return f"{controller['name']} (guid={controller['guid']})"


def _selected_controller_index(
    controllers: list[dict[str, object]], selected: dict[str, str] | None
) -> int | None:
    for index, controller in enumerate(controllers):
        if _controller_matches_selection(controller, selected):
            return index
    return None


def _create_tray_icon() -> QIcon:
    pixmap = QtGui.QPixmap(64, 64)
    pixmap.fill(QtCore.Qt.GlobalColor.transparent)

    painter = QtGui.QPainter(pixmap)
    painter.setRenderHint(QtGui.QPainter.RenderHint.Antialiasing)

    outer_rect = QtCore.QRectF(8, 18, 48, 28)
    inner_rect = QtCore.QRectF(10, 20, 44, 24)

    painter.setPen(QtCore.Qt.PenStyle.NoPen)
    painter.setBrush(QtGui.QColor(44, 47, 51, 255))
    painter.drawRoundedRect(outer_rect, 10, 10)

    painter.setPen(QtGui.QPen(QtGui.QColor(255, 255, 255, 255), 2))
    painter.setBrush(QtCore.Qt.BrushStyle.NoBrush)
    painter.drawRoundedRect(inner_rect, 8, 8)

    painter.setPen(QtCore.Qt.PenStyle.NoPen)
    painter.setBrush(QtGui.QColor(63, 140, 255, 255))
    painter.drawEllipse(QtCore.QRectF(16, 25, 8, 8))
    painter.drawEllipse(QtCore.QRectF(40, 25, 8, 8))
    painter.end()

    return QtGui.QIcon(pixmap)


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
    ) -> None:
        self.config_path = config_path
        self.server_backend = server_backend
        self.hide_on_close = hide_on_close
        self.quit_callback = quit_callback
        self.controllers: list[dict[str, object]] = []

        owner = self

        class _Window(QtWidgets.QWidget):
            def closeEvent(self, event: QCloseEvent) -> None:  # noqa: N802
                owner._handle_close_event(event)

            def changeEvent(self, event: QEvent) -> None:  # noqa: N802
                super().changeEvent(event)
                owner._handle_change_event(event)

        self.widget = _Window()
        self.widget.setWindowTitle("Gamepad Controller Selector")
        self.widget.setWindowIcon(_create_tray_icon())
        self.widget.resize(540, 360)

        layout = QtWidgets.QVBoxLayout(self.widget)

        self.current_label = QtWidgets.QLabel()
        layout.addWidget(self.current_label)

        self.server_label = QtWidgets.QLabel()
        layout.addWidget(self.server_label)

        self.status_label = QtWidgets.QLabel()
        layout.addWidget(self.status_label)

        self.controller_list = QtWidgets.QListWidget()
        self.controller_list.itemSelectionChanged.connect(
            self._update_select_button_state
        )
        self.controller_list.itemDoubleClicked.connect(
            lambda _item: self.select_current_controller()
        )
        layout.addWidget(self.controller_list, stretch=1)

        button_row = QtWidgets.QHBoxLayout()
        layout.addLayout(button_row)

        self.select_button = QtWidgets.QPushButton("Select")
        self.select_button.clicked.connect(self.select_current_controller)
        button_row.addWidget(self.select_button)

        use_any_button = QtWidgets.QPushButton("Use Any Controller")
        use_any_button.clicked.connect(self.use_any_controller)
        button_row.addWidget(use_any_button)

        refresh_button = QtWidgets.QPushButton("Refresh")
        refresh_button.clicked.connect(self.refresh)
        button_row.addWidget(refresh_button)

        button_row.addStretch(1)

        close_button = QtWidgets.QPushButton(
            "Quit" if hide_on_close else "Close"
        )
        close_button.clicked.connect(
            self._request_quit if hide_on_close else self.widget.close
        )
        button_row.addWidget(close_button)

        self.refresh()

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
        self.current_label.setText(_current_selection_label(self.config_path))
        if self.server_backend is None:
            self.server_label.setText("")
        else:
            self.server_backend.ensure_started()
            self.server_label.setText(self.server_backend.status_label())

        self.controller_list.clear()
        try:
            self.controllers = _list_available_controllers()
        except RuntimeError as exc:
            logger.exception("Failed to refresh controllers")
            self.controllers = []
            self.status_label.setText(str(exc))
            self.select_button.setEnabled(False)
            return

        if not self.controllers:
            self.status_label.setText("No compatible controllers detected.")
            self._update_select_button_state()
            return

        selected = _load_selected_controller(self.config_path)
        selected_row = _selected_controller_index(self.controllers, selected)
        for controller in self.controllers:
            self.controller_list.addItem(_controller_menu_label(controller))

        self.status_label.setText(
            f"Detected {len(self.controllers)} compatible controller(s)."
        )
        if selected_row is not None:
            self.controller_list.setCurrentRow(selected_row)
        self._update_select_button_state()

    def select_current_controller(self) -> None:
        selected_row = self.controller_list.currentRow()
        if not 0 <= selected_row < len(self.controllers):
            return
        _save_selected_controller(
            self.config_path, self.controllers[selected_row]
        )
        self.refresh()
        self._dismiss()

    def use_any_controller(self) -> None:
        _clear_selected_controller(self.config_path)
        self.refresh()
        self._dismiss()


class ControllerSelectorTray:
    def __init__(
        self,
        config_path: Path | None = None,
        *,
        lan: bool = False,
        terminal: bool = False,
    ) -> None:
        self.config_path = config_path or _controller_config_path()
        self.server_backend = ManagedServerBackend(
            config_path=self.config_path, lan=lan, terminal=terminal
        )
        self.server_backend.ensure_started()

        self.window = ControllerSelectorWindow(
            self.config_path,
            server_backend=self.server_backend,
            hide_on_close=True,
            quit_callback=self._request_quit,
        )

        self.tray = QtWidgets.QSystemTrayIcon(_create_tray_icon())
        self.tray.setToolTip(_current_selection_label(self.config_path))
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

    def _select_controller(self, controller: dict[str, object]) -> None:
        _save_selected_controller(self.config_path, controller)
        self.window.refresh()
        self.rebuild_menu()

    def _use_any_controller(self) -> None:
        _clear_selected_controller(self.config_path)
        self.window.refresh()
        self.rebuild_menu()

    def rebuild_menu(self) -> None:
        self.server_backend.ensure_started()
        self.menu.clear()

        current_action = self.menu.addAction(
            _current_selection_label(self.config_path)
        )
        current_action.setEnabled(False)

        server_action = self.menu.addAction(self.server_backend.status_label())
        server_action.setEnabled(False)

        self.menu.addSeparator()

        try:
            controllers = _list_available_controllers()
        except RuntimeError as exc:
            logger.exception("Failed to rebuild tray menu")
            error_action = self.menu.addAction(str(exc))
            error_action.setEnabled(False)
        else:
            selected = _load_selected_controller(self.config_path)
            if controllers:
                for controller in controllers:
                    action = self.menu.addAction(
                        _controller_menu_label(controller)
                    )
                    action.setCheckable(True)
                    action.setChecked(
                        _controller_matches_selection(controller, selected)
                    )
                    action.triggered.connect(
                        lambda _checked=False, controller=controller: self._select_controller(
                            controller
                        )
                    )
            else:
                unavailable_action = self.menu.addAction(
                    "No compatible controllers detected"
                )
                unavailable_action.setEnabled(False)

        self.menu.addSeparator()

        show_hide_text = (
            "Hide selector" if self.window.is_visible() else "Show selector"
        )
        show_hide_action = self.menu.addAction(show_hide_text)
        show_hide_action.triggered.connect(
            lambda: (
                self.window.widget.hide()
                if self.window.is_visible()
                else self.window.show()
            )
        )

        use_any_action = self.menu.addAction("Use any controller")
        use_any_action.triggered.connect(self._use_any_controller)

        refresh_action = self.menu.addAction("Refresh")
        refresh_action.triggered.connect(self._refresh)

        quit_action = self.menu.addAction("Quit")
        quit_action.triggered.connect(self._request_quit)

        self.tray.setToolTip(_current_selection_label(self.config_path))

    def _refresh(self) -> None:
        self.window.refresh()
        self.rebuild_menu()

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

    def run(self) -> int:
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
        return int(app.exec())


def _create_application() -> QApplication:
    app = QApplication.instance()
    if app is None:
        app = QApplication([sys.argv[0]])
    elif not isinstance(app, QApplication):
        msg = "A non-widget Qt application already exists."
        raise TypeError(msg)
    app.setApplicationName("Gamepad Controller Selector")
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


def _run_popup(config_path: Path) -> int:
    app = _create_application()
    signal_timer = _install_signal_handlers(app.quit)
    window = ControllerSelectorWindow(
        config_path, server_backend=None, hide_on_close=False
    )
    window.show()
    try:
        return app.exec()
    finally:
        signal_timer.stop()


def run_tray(
    *,
    config_path: Path | None = None,
    lan: bool = False,
    terminal: bool = False,
) -> int:
    _create_application()
    tray = ControllerSelectorTray(config_path, lan=lan, terminal=terminal)
    signal_timer = _install_signal_handlers(tray._quit)
    try:
        return tray.run()
    finally:
        signal_timer.stop()


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--popup",
        action="store_true",
        help="Open the controller selector window instead of the tray icon.",
    )
    args = parser.parse_args(args=argv)

    try:
        if args.popup:
            return _run_popup(_controller_config_path())
        return run_tray()
    except (RuntimeError, TypeError) as exc:
        print(str(exc), file=sys.stderr)
        return 1

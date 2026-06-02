from __future__ import annotations

from pathlib import Path
from typing import TYPE_CHECKING, cast

from gamepad_websocket_server.application import (
    ServerRunConfig,
    _save_selected_controller,
)
from gamepad_websocket_server.tray import (
    ManagedServerBackend,
    _controller_matches_selection,
    _controller_menu_label,
    _current_selection_label,
    _selected_controller_index,
)

if TYPE_CHECKING:
    from threading import Event

    from pytest import MonkeyPatch


def test_current_selection_label_defaults_to_any_controller(
    tmp_path: Path,
) -> None:
    assert _current_selection_label(
        tmp_path / "controller-selection.json"
    ) == ("Current: any controller")


def test_current_selection_label_uses_saved_guid(tmp_path: Path) -> None:
    path = tmp_path / "controller-selection.json"
    _save_selected_controller(path, {"guid": "abc123", "name": "Pad"})

    assert _current_selection_label(path) == "Current: guid=abc123"


def test_controller_matches_selection_is_case_insensitive_for_name() -> None:
    assert _controller_matches_selection(
        {"guid": "guid-1", "name": "Xbox Wireless Controller"},
        {"guid": "", "name": "wireless"},
    )


def test_controller_menu_label_includes_name_and_guid() -> None:
    assert _controller_menu_label({"name": "Pad", "guid": "guid-1"}) == (
        "Pad (guid=guid-1)"
    )


def test_selected_controller_index_returns_matching_controller() -> None:
    controllers: list[dict[str, object]] = [
        {"name": "First Pad", "guid": "guid-1"},
        {"name": "Second Pad", "guid": "guid-2"},
    ]

    assert (
        _selected_controller_index(controllers, {"guid": "guid-2", "name": ""})
        == 1
    )


def test_selected_controller_index_returns_none_for_any_controller() -> None:
    controllers: list[dict[str, object]] = [{"name": "Pad", "guid": "guid-1"}]

    assert _selected_controller_index(controllers, None) is None


def test_managed_server_backend_starts_in_process_server(
    monkeypatch: MonkeyPatch,
) -> None:
    calls: list[object] = []

    def fake_run_server(config: ServerRunConfig) -> None:
        calls.append(config)

    monkeypatch.setattr(
        "gamepad_websocket_server.tray.run_server", fake_run_server
    )

    backend = ManagedServerBackend(
        config_path=Path("controller-selection.json")
    )
    backend.ensure_started()
    backend.thread.join(timeout=1) if backend.thread is not None else None

    assert calls
    assert backend.status_label() == "Server: stopped"


def test_managed_server_backend_status_is_running_while_thread_alive(
    monkeypatch: MonkeyPatch,
) -> None:
    started = False

    def fake_run_server(config: ServerRunConfig) -> None:
        nonlocal started
        started = True
        stop_event = cast("Event", config.stop_event)
        stop_event.wait(timeout=1)

    monkeypatch.setattr(
        "gamepad_websocket_server.tray.run_server", fake_run_server
    )

    backend = ManagedServerBackend(
        config_path=Path("controller-selection.json")
    )
    backend.ensure_started()

    assert started
    assert backend.status_label() == "Server: running"

    backend.stop()


def test_managed_server_backend_stop_signals_thread(
    monkeypatch: MonkeyPatch,
) -> None:
    stopped = False

    def fake_run_server(config: ServerRunConfig) -> None:
        nonlocal stopped
        stop_event = cast("Event", config.stop_event)
        stop_event.wait(timeout=1)
        stopped = stop_event.is_set()

    monkeypatch.setattr(
        "gamepad_websocket_server.tray.run_server", fake_run_server
    )

    backend = ManagedServerBackend(
        config_path=Path("controller-selection.json")
    )
    backend.ensure_started()
    backend.stop()
    backend.thread.join(timeout=1) if backend.thread is not None else None

    assert stopped

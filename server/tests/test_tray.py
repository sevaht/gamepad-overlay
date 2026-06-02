from __future__ import annotations

import subprocess
from typing import TYPE_CHECKING

from gamepad_websocket_server.application import _save_selected_controller
from gamepad_websocket_server.tray import (
    ManagedServerProcess,
    _controller_matches_selection,
    _controller_menu_label,
    _current_selection_label,
    _selected_controller_index,
)

if TYPE_CHECKING:
    from pathlib import Path

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


def test_managed_server_process_uses_existing_server(
    monkeypatch: MonkeyPatch,
) -> None:
    monkeypatch.setattr(
        "gamepad_websocket_server.tray._is_local_server_running", lambda: True
    )

    process = ManagedServerProcess()
    process.ensure_started()

    assert process.process is None
    assert not process.owns_process
    assert (
        process.status_label() == "Server: using an already running instance"
    )


def test_managed_server_process_starts_server_when_missing(
    monkeypatch: MonkeyPatch,
) -> None:
    started: list[object] = []

    class FakeProcess:
        def poll(self) -> None:
            return None

    def fake_popen(*_args: object, **_kwargs: object) -> FakeProcess:
        process = FakeProcess()
        started.append(process)
        return process

    monkeypatch.setattr(
        "gamepad_websocket_server.tray._is_local_server_running", lambda: False
    )
    monkeypatch.setattr("subprocess.Popen", fake_popen)

    process = ManagedServerProcess()
    process.ensure_started()

    assert process.process is started[0]
    assert process.owns_process
    assert process.status_label() == "Server: running"


def test_managed_server_process_kills_if_terminate_does_not_finish() -> None:
    calls: list[str] = []

    class FakeProcess:
        returncode: int | None = None

        def poll(self) -> int | None:
            return self.returncode

        def terminate(self) -> None:
            calls.append("terminate")

        def wait(self, timeout: float | None = None) -> int | None:
            calls.append(f"wait:{timeout}")
            if timeout is not None and timeout < 1:
                raise subprocess.TimeoutExpired(cmd="server", timeout=timeout)
            self.returncode = -9
            return self.returncode

        def kill(self) -> None:
            calls.append("kill")

    process = ManagedServerProcess(process=FakeProcess(), owns_process=True)
    process.stop()

    assert calls == ["terminate", "wait:0.2", "kill", "wait:5"]

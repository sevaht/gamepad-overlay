from __future__ import annotations

import json
from pathlib import Path
from typing import TYPE_CHECKING, cast

from gamepad_overlay.application import (
    GamepadInfo,
    GamepadSelection,
    SDLGamepad,
    ServerRunConfig,
)
from gamepad_overlay.gamepad_selector import (
    _gamepad_display_names,
    _selected_gamepad_index,
    _status_text,
)
from gamepad_overlay.tray import ManagedServerBackend

if TYPE_CHECKING:
    from threading import Event

    from pytest import MonkeyPatch


def _make_gamepad(  # noqa: PLR0913
    *,
    index: int = 0,
    name: str = "Pad",
    guid: str = "guid-1",
    path: str = "",
    port: str = "",
    vendor: str = "",
    product: str = "",
    product_version: str = "",
) -> GamepadInfo:
    return GamepadInfo(
        index=index,
        name=name,
        guid=guid,
        path=path,
        port=port,
        vendor=vendor,
        product=product,
        product_version=product_version,
    )


def test_status_text_defaults_to_detached() -> None:
    assert _status_text(attached=False, client_count=0) == (
        "Gamepad Overlay - Detached (0 Clients Connected)"
    )


def test_status_text_uses_attached_state_and_client_count() -> None:
    assert _status_text(attached=True, client_count=2) == (
        "Gamepad Overlay - Attached (2 Clients Connected)"
    )


def test_status_text_uses_singular_client_label() -> None:
    assert _status_text(attached=True, client_count=1) == (
        "Gamepad Overlay - Attached (1 Client Connected)"
    )


def test_save_selected_gamepad_persists_only_match_fields(
    tmp_path: Path,
) -> None:
    path = tmp_path / "gamepad-selection.json"

    GamepadSelection(
        guid="guid-1", vendor="1118", product="654", port="", name="Pad"
    ).save(path)

    assert json.loads(path.read_text(encoding="utf-8")) == {
        "guid": "guid-1",
        "vendor": "1118",
        "product": "654",
        "port": "",
        "name": "Pad",
    }


def test_gamepad_matches_selection_is_case_insensitive_for_guid() -> None:
    gamepad = _make_gamepad(guid="GUID-1", name="Xbox Wireless Gamepad")
    selection = GamepadSelection(guid="guid-1")
    assert selection.matches(gamepad)


def test_gamepad_matches_selection_ignores_unstable_metadata() -> None:
    gamepad = _make_gamepad(
        guid="guid-1", name="Pad", path="new-path", product_version="2"
    )
    selection = GamepadSelection(guid="GUID-1", name="Pad")
    assert selection.matches(gamepad)


def test_gamepad_matches_selection_requires_stable_metadata() -> None:
    gamepad = _make_gamepad(
        guid="guid-1", name="Pad", vendor="1118", product="654"
    )
    selection = GamepadSelection(
        guid="guid-1", name="Pad", vendor="1118", product="999"
    )
    assert not selection.matches(gamepad)


def test_gamepad_matches_selection_ignores_name_differences() -> None:
    # Name is display-only; different names do not block a match on hardware identity.
    gamepad = _make_gamepad(guid="guid-1", name="Other Pad")
    selection = GamepadSelection(guid="guid-1", name="Xbox")
    assert selection.matches(gamepad)


def test_gamepad_metadata_summary_formats_vid_pid() -> None:
    gamepad = _make_gamepad(
        vendor="1118", product="654", product_version="276"
    )
    assert gamepad.metadata_summary() == "[045e:028e]"


def test_gamepad_display_names_disambiguates_duplicate_names() -> None:
    gamepads = [
        _make_gamepad(name="Pad", guid="000000000001"),
        _make_gamepad(name="Pad", guid="000000000002"),
    ]

    assert _gamepad_display_names(gamepads) == (["Pad [1]", "Pad [2]"])


def test_selected_gamepad_index_returns_matching_gamepad() -> None:
    gamepads = [
        _make_gamepad(name="First Pad", guid="guid-1"),
        _make_gamepad(name="Second Pad", guid="guid-2"),
    ]

    assert (
        _selected_gamepad_index(gamepads, GamepadSelection(guid="guid-2")) == 1
    )


def test_selected_gamepad_index_returns_none_for_any_gamepad() -> None:
    gamepads = [_make_gamepad(name="Pad", guid="guid-1")]

    assert _selected_gamepad_index(gamepads, None) is None


def test_managed_server_backend_starts_in_process_server(
    monkeypatch: MonkeyPatch,
) -> None:
    calls: list[object] = []

    def fake_run_server(config: ServerRunConfig) -> None:
        calls.append(config)

    monkeypatch.setattr("gamepad_overlay.tray.run_server", fake_run_server)

    backend = ManagedServerBackend(config_path=Path("gamepad-selection.json"))
    backend.ensure_started()
    backend.thread.join(timeout=1) if backend.thread is not None else None

    assert calls
    assert backend.status_label() == "Server: stopped"


def test_managed_server_backend_tracks_gamepad_connection() -> None:
    backend = ManagedServerBackend(config_path=Path("gamepad-selection.json"))

    assert not backend.is_gamepad_connected()
    backend.active_gamepad_info = _make_gamepad(guid="guid-1")
    assert backend.is_gamepad_connected()


def test_reload_selection_updates_saved_match_fields(tmp_path: Path) -> None:
    config_path = tmp_path / "gamepad-selection.json"
    gamepad = object.__new__(SDLGamepad)
    gamepad.selected_gamepad = GamepadSelection(
        guid="guid-1", name="Pad", vendor="1118", product="654", port=""
    )
    gamepad._selection_mtime_ns = None
    gamepad._gamepad = None
    gamepad._gamepad_id = None

    GamepadSelection(
        guid="guid-1", name="Pad", vendor="1118", product="654", port=""
    ).save(config_path)
    gamepad.reload_selection_from_config(config_path)

    assert gamepad.selected_gamepad is not None
    assert gamepad.selected_gamepad == GamepadSelection(
        guid="guid-1", vendor="1118", product="654", port="", name="Pad"
    )

    GamepadSelection.clear(config_path)
    gamepad.reload_selection_from_config(config_path)

    assert gamepad.selected_gamepad is None


def test_managed_server_backend_status_is_running_while_thread_alive(
    monkeypatch: MonkeyPatch,
) -> None:
    started = False

    def fake_run_server(config: ServerRunConfig) -> None:
        nonlocal started
        started = True
        stop_event = cast("Event", config.stop_event)
        stop_event.wait(timeout=1)

    monkeypatch.setattr("gamepad_overlay.tray.run_server", fake_run_server)

    backend = ManagedServerBackend(config_path=Path("gamepad-selection.json"))
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

    monkeypatch.setattr("gamepad_overlay.tray.run_server", fake_run_server)

    backend = ManagedServerBackend(config_path=Path("gamepad-selection.json"))
    backend.ensure_started()
    backend.stop()
    backend.thread.join(timeout=1) if backend.thread is not None else None

    assert stopped

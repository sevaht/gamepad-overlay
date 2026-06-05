from __future__ import annotations

import json
from pathlib import Path
from typing import TYPE_CHECKING, cast

from gamepad_overlay.application import (
    SDLGameController,
    ServerRunConfig,
    _clear_selected_controller,
    _controller_metadata_summary,
    _save_selected_controller,
)
from gamepad_overlay.tray import (
    ManagedServerBackend,
    _controller_display_names,
    _controller_matches_selection,
    _controller_row_badges,
    _controller_row_label,
    _selected_controller_index,
    _status_text,
)

if TYPE_CHECKING:
    from threading import Event

    from pytest import MonkeyPatch


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


def test_save_selected_controller_persists_only_match_fields(
    tmp_path: Path,
) -> None:
    path = tmp_path / "controller-selection.json"

    _save_selected_controller(
        path,
        {
            "guid": "guid-1",
            "name": "Pad",
            "path": "device-path",
            "vendor": "1118",
            "product": "654",
            "product_version": "276",
        },
    )

    assert json.loads(path.read_text(encoding="utf-8")) == {
        "guid": "guid-1",
        "vendor": "1118",
        "product": "654",
        "name": "Pad",
    }


def test_controller_matches_selection_is_case_insensitive_for_name() -> None:
    assert _controller_matches_selection(
        {"guid": "guid-1", "name": "Xbox Wireless Controller"},
        {"guid": "", "name": "wireless"},
    )


def test_controller_matches_selection_ignores_unstable_metadata() -> None:
    assert _controller_matches_selection(
        {
            "guid": "guid-1",
            "name": "Pad",
            "path": "new-path",
            "product_version": "2",
        },
        {
            "guid": "GUID-1",
            "name": "Pad",
            "path": "old-path",
            "product_version": "1",
        },
    )


def test_controller_matches_selection_requires_stable_metadata() -> None:
    assert not _controller_matches_selection(
        {"guid": "guid-1", "name": "Pad", "vendor": "1118", "product": "654"},
        {"guid": "guid-1", "name": "Pad", "vendor": "1118", "product": "999"},
    )


def test_controller_matches_selection_requires_name_when_saved() -> None:
    assert not _controller_matches_selection(
        {"guid": "guid-1", "name": "Other Pad"},
        {"guid": "guid-1", "name": "Xbox"},
    )


def test_controller_row_label_includes_guid_detail() -> None:
    assert _controller_row_label({"name": "Pad", "guid": "guid-1"}, "Pad") == (
        "Pad\n[guid-1]"
    )


def test_controller_row_badges_mark_saved_controller_selected() -> None:
    assert _controller_row_badges(
        {"name": "Pad", "guid": "guid-1"}, {"guid": "guid-1", "name": ""}, None
    ) == ("Selected",)


def test_controller_row_badges_mark_active_controller() -> None:
    assert _controller_row_badges(
        {"name": "Pad", "guid": "guid-1"}, None, {"guid": "guid-1", "name": ""}
    ) == ("★",)


def test_controller_row_badges_combine_active_and_selected() -> None:
    assert _controller_row_badges(
        {"name": "Pad", "guid": "guid-1"},
        {"guid": "guid-1", "name": ""},
        {"guid": "guid-1", "name": ""},
    ) == ("★", "Selected")


def test_controller_row_badges_omit_unmatched_controller() -> None:
    assert (
        _controller_row_badges(
            {"name": "Pad", "guid": "guid-1"},
            {"guid": "guid-2", "name": ""},
            {"guid": "guid-3", "name": ""},
        )
        == ()
    )


def test_controller_row_label_prefers_vid_pid_detail() -> None:
    assert _controller_row_label(
        {"name": "Pad", "guid": "guid-1", "vendor": "1118", "product": "654"},
        "Pad",
    ) == ("Pad\n[045e:028e] [guid-1]")


def test_controller_row_label_includes_product_version() -> None:
    assert _controller_row_label(
        {
            "name": "Pad",
            "guid": "guid-1",
            "vendor": "1118",
            "product": "654",
            "product_version": "276",
        },
        "Pad",
    ) == ("Pad\nv276 [045e:028e] [guid-1]")


def test_controller_metadata_summary_can_put_version_last() -> None:
    assert (
        _controller_metadata_summary(
            {
                "guid": "guid-1",
                "vendor": "1118",
                "product": "654",
                "product_version": "276",
            },
            version_first=False,
        )
        == "[045e:028e] [guid-1] v276"
    )


def test_controller_display_names_disambiguates_duplicate_names() -> None:
    controllers: list[dict[str, object]] = [
        {"name": "Pad", "guid": "000000000001"},
        {"name": "Pad", "guid": "000000000002"},
    ]

    assert _controller_display_names(controllers) == (["Pad [1]", "Pad [2]"])


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

    monkeypatch.setattr("gamepad_overlay.tray.run_server", fake_run_server)

    backend = ManagedServerBackend(
        config_path=Path("controller-selection.json")
    )
    backend.ensure_started()
    backend.thread.join(timeout=1) if backend.thread is not None else None

    assert calls
    assert backend.status_label() == "Server: stopped"


def test_managed_server_backend_tracks_controller_connection() -> None:
    backend = ManagedServerBackend(
        config_path=Path("controller-selection.json")
    )

    assert not backend.is_controller_connected()
    backend.active_controller_info = {"guid": "guid-1"}
    assert backend.is_controller_connected()


def test_reload_selection_updates_saved_match_fields(tmp_path: Path) -> None:
    config_path = tmp_path / "controller-selection.json"
    controller = object.__new__(SDLGameController)
    controller.selected_guid = "guid-1"
    controller.name_filter = None
    controller.selected_controller = {
        "guid": "guid-1",
        "name": "Pad",
        "vendor": "1118",
        "product": "654",
    }
    controller._selection_mtime_ns = None
    controller._controller = None
    controller._instance_id = None

    _save_selected_controller(
        config_path,
        {
            "guid": "guid-1",
            "name": "Pad",
            "path": "new-path",
            "vendor": "1118",
            "product": "654",
            "product_version": "276",
        },
    )
    controller.reload_selection_from_config(config_path)

    assert controller.selected_controller is not None
    assert controller.selected_controller == {
        "guid": "guid-1",
        "vendor": "1118",
        "product": "654",
        "name": "Pad",
    }

    _clear_selected_controller(config_path)
    controller.reload_selection_from_config(config_path)

    assert controller.selected_controller is None
    assert controller.selected_guid is None


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

    monkeypatch.setattr("gamepad_overlay.tray.run_server", fake_run_server)

    backend = ManagedServerBackend(
        config_path=Path("controller-selection.json")
    )
    backend.ensure_started()
    backend.stop()
    backend.thread.join(timeout=1) if backend.thread is not None else None

    assert stopped

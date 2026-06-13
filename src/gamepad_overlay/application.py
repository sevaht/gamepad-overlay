from __future__ import annotations

import argparse
import importlib.metadata
import logging
from typing import TYPE_CHECKING

from sevaht_utility.log_utility import add_log_arguments, configure_logging

from . import platform_dirs
from .gamepad import (
    CONFIG_FILE_NAME,
    GamepadSelection,
    SDLGamepad,
    port_display_name,
)
from .server import (
    MAX_PORT,
    MIN_PORT,
    ServerRunConfig,
    load_server_port,
    run_server,
    save_server_port,
)

if TYPE_CHECKING:
    from collections.abc import Sequence
    from pathlib import Path

logger = logging.getLogger(__name__)


def _config_path() -> Path:
    return platform_dirs().user_config_path / CONFIG_FILE_NAME


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="gamepad-overlay",
        description=importlib.metadata.metadata(__package__).get("summary"),
    )

    selection_group = parser.add_argument_group(
        "selection mode",
        "Save a gamepad selection and exit."
        " Cannot be combined with run mode arguments.",
    )
    selection_group.add_argument(
        "--list-gamepads",
        action="store_true",
        help="List connected gamepads and exit.",
    )
    selection_group.add_argument(
        "--any-gamepad",
        action="store_true",
        help="Clear the saved gamepad selection (use any gamepad) and exit.",
    )
    selection_group.add_argument(
        "--select-gamepad",
        action="store_true",
        help="Interactively select a connected gamepad, save it, and exit.",
    )
    gamepad_id_group = selection_group.add_mutually_exclusive_group()
    gamepad_id_group.add_argument(
        "--gamepad-guid",
        metavar="GUID",
        help="Save a gamepad selection by GUID and exit.",
    )
    gamepad_id_group.add_argument(
        "--gamepad-name",
        metavar="NAME",
        help="Save a gamepad selection by name substring (resolves to the"
        " matching controller's hardware identity) and exit.",
    )
    selection_group.add_argument(
        "--gamepad-port",
        metavar="PORT",
        help="Include physical port in the saved selection"
        " (combinable with --gamepad-guid or --gamepad-name).",
    )
    selection_group.add_argument(
        "--port",
        type=int,
        metavar="PORT",
        help=f"Set the websocket server port ({MIN_PORT}-{MAX_PORT}) and exit.",
    )

    run_group = parser.add_argument_group(
        "run mode",
        "Start the server."
        " Cannot be combined with selection mode arguments.",
    )
    run_group.add_argument(
        "--headless",
        action="store_true",
        help="Run the server directly without the system tray.",
    )
    run_group.add_argument(
        "--hide",
        action="store_true",
        help="Start the system tray with the selector window hidden.",
    )
    output_group = run_group.add_mutually_exclusive_group()
    output_group.add_argument(
        "--lan",
        action="store_true",
        help="Bind to 0.0.0.0 instead of localhost (for testing across machines; not intended for normal use).",
    )
    output_group.add_argument(
        "--terminal",
        action="store_true",
        help="Print gamepad state to the terminal instead of broadcasting"
        " via websocket.",
    )

    add_log_arguments(parser)
    return parser


def _print_available_gamepads() -> int:
    gamepads = SDLGamepad.list_available_gamepads()
    if not gamepads:
        print("No compatible gamepads detected.")
        return 0
    for g in gamepads:
        meta = g.metadata_summary()
        print(f"[{g.index}] {g.name}" + (f"  {meta}" if meta else ""))
    return 0


def _select_and_save_gamepad(config_path: Path) -> int:
    selected = _interactive_select_gamepad()
    if selected is None:
        print("No gamepad selected.")
        return 1
    if selected.is_any():
        GamepadSelection.clear(config_path)
        print("Will use any gamepad.")
        return 0
    selected.save(config_path)
    print(f"Saved gamepad selection: {selected.target_description()}")
    return 0


def _save_gamepad_by_criteria(
    guid: str | None, name: str | None, port: str | None, config_path: Path
) -> int:
    if name:
        gamepads = SDLGamepad.list_available_gamepads()
        matches = [
            g
            for g in gamepads
            if name.lower() in g.name.lower() and (not port or g.port == port)
        ]
        if not matches:
            desc = repr(name) + (f" on port {port!r}" if port else "")
            print(f"No connected gamepad matches {desc}.")
            return 1
        found = matches[0]
        selection = GamepadSelection(
            guid=found.guid,
            vendor=found.vendor,
            product=found.product,
            port=port or "",
            name=found.name,
        )
    elif guid:
        gamepads = SDLGamepad.list_available_gamepads()
        found_gamepad = next(
            (g for g in gamepads if g.guid.lower() == guid.lower()), None
        )
        selection = GamepadSelection(
            guid=guid,
            vendor=found_gamepad.vendor if found_gamepad else "",
            product=found_gamepad.product if found_gamepad else "",
            port=port or "",
            name=found_gamepad.name if found_gamepad else "",
        )
    else:
        selection = GamepadSelection(port=port or "")
    selection.save(config_path)
    print(f"Saved gamepad selection: {selection.target_description()}")
    return 0


def _run_tray(args: argparse.Namespace, config_path: Path) -> int:
    from .tray import run_tray

    return run_tray(
        config_path=config_path,
        lan=args.lan,
        terminal=args.terminal,
        start_hidden=args.hide,
    )


def _run_headless_server(args: argparse.Namespace, config_path: Path) -> int:
    return run_server(
        ServerRunConfig(
            config_path=config_path,
            port=load_server_port(config_path),
            lan=args.lan,
            terminal=args.terminal,
        )
    )


def main(  # noqa: C901, PLR0911, PLR0912
    argv: Sequence[str] | None = None,
) -> int:
    parser = _build_parser()
    args = parser.parse_args(args=argv)
    configure_logging(args)

    config_path = _config_path()

    # Detect which mode is active
    selection_args: list[str] = []
    if args.list_gamepads:
        selection_args.append("--list-gamepads")
    if args.any_gamepad:
        selection_args.append("--any-gamepad")
    if args.select_gamepad:
        selection_args.append("--select-gamepad")
    has_criteria = bool(
        args.gamepad_guid or args.gamepad_name or args.gamepad_port
    )
    if has_criteria:
        selection_args.append("--gamepad-guid/name/port")
    if args.port is not None:
        selection_args.append("--port")

    run_args: list[str] = []
    if args.headless:
        run_args.append("--headless")
    if args.hide:
        run_args.append("--hide")
    if args.lan:
        run_args.append("--lan")
    if args.terminal:
        run_args.append("--terminal")

    if len(selection_args) > 1:
        parser.error(
            f"these arguments cannot be combined: {', '.join(selection_args)}"
        )
    if selection_args and run_args:
        parser.error(
            f"selection arguments ({', '.join(selection_args)}) cannot be"
            f" combined with run arguments ({', '.join(run_args)})"
        )

    # Selection mode: save a selection and exit
    if args.list_gamepads:
        return _print_available_gamepads()

    if args.any_gamepad:
        GamepadSelection.clear(config_path)
        print("Will use any gamepad.")
        return 0

    if args.select_gamepad:
        return _select_and_save_gamepad(config_path)

    if has_criteria:
        return _save_gamepad_by_criteria(
            guid=args.gamepad_guid,
            name=args.gamepad_name,
            port=args.gamepad_port,
            config_path=config_path,
        )

    if args.port is not None:
        if not (MIN_PORT <= args.port <= MAX_PORT):
            parser.error(f"--port must be between {MIN_PORT} and {MAX_PORT}")
        save_server_port(args.port, _config_path())
        print(f"Server port set to {args.port}.")
        return 0

    # Run mode
    if not args.headless:
        return _run_tray(args, config_path)

    return _run_headless_server(args, config_path)


def _interactive_select_gamepad() -> (  # noqa: C901, PLR0912
    GamepadSelection | None
):
    gamepads = SDLGamepad.list_available_gamepads()
    if not gamepads:
        print("No compatible gamepads detected.")
        return None
    print("Detected gamepads:")
    for idx, g in enumerate(gamepads, start=1):
        meta = g.metadata_summary()
        print(f"  {idx}) {g.name}" + (f"  {meta}" if meta else ""))
    print("  0) (any gamepad)")
    print()
    while True:
        try:
            choice = input(
                "Select gamepad number (0 for any, or blank to cancel): "
            ).strip()
        except KeyboardInterrupt:
            print()
            return None
        if choice == "":
            return None
        if not choice.isdigit():
            print("Invalid selection. Enter a number.")
            continue
        selected_index = int(choice)
        if selected_index == 0:
            return GamepadSelection()
        if 1 <= selected_index <= len(gamepads):
            found = gamepads[selected_index - 1]
            pin_identity = True
            pin_port = False
            if found.port:
                port_disp = port_display_name(found.port)
                print("  Match by:")
                print("    1) Controller identity only (any port)")
                print(f"    2) Physical port only ({port_disp})")
                print("    3) Both identity and physical port")
                while True:
                    try:
                        criteria = input("  Choose [1]: ").strip()
                    except KeyboardInterrupt:
                        print()
                        return None
                    if criteria in ("", "1"):
                        break
                    if criteria == "2":
                        pin_identity = False
                        pin_port = True
                        break
                    if criteria == "3":
                        pin_port = True
                        break
                    print("  Enter 1, 2, or 3.")
            return found.as_selection(
                pin_identity=pin_identity, pin_port=pin_port
            )
        print("Selection out of range.")

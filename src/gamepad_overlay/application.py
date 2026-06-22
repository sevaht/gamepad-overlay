from __future__ import annotations

import argparse
import importlib.metadata
import logging
from typing import TYPE_CHECKING

from sevaht_utility.log_utility import add_log_arguments, configure_logging

from . import user_config_path
from .config import CONFIG_FILE_NAME
from .gamepad import (
    GamepadInfo,
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
    return user_config_path() / CONFIG_FILE_NAME


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
        " matching gamepad's hardware identity) and exit.",
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


def _gamepad_label(gamepad: GamepadInfo) -> str:
    """Return ``"<name>  <metadata>"`` (metadata omitted when empty)."""
    metadata = gamepad.metadata_summary()
    return f"{gamepad.name}  {metadata}" if metadata else gamepad.name


def _print_available_gamepads() -> int:
    gamepads = SDLGamepad.list_available_gamepads()
    if not gamepads:
        print("No compatible gamepads detected.")
        return 0
    for gamepad in gamepads:
        print(f"[{gamepad.index}] {_gamepad_label(gamepad)}")
    return 0


def _select_and_save_gamepad(config_path: Path) -> int:
    selected_gamepad = _interactive_select_gamepad()
    if selected_gamepad is None:
        print("No gamepad selected.")
        return 1
    if selected_gamepad.is_any():
        GamepadSelection.clear(config_path)
        print("Will use any gamepad.")
        return 0
    selected_gamepad.save(config_path)
    print(f"Saved gamepad selection: {selected_gamepad.target_description()}")
    return 0


def _save_gamepad_by_criteria(
    guid: str | None, name: str | None, port: str | None, config_path: Path
) -> int:
    if name:
        matches = [
            gamepad
            for gamepad in SDLGamepad.list_available_gamepads()
            if name.lower() in gamepad.name.lower()
            and (not port or gamepad.port == port)
        ]
        if not matches:
            description = repr(name) + (f" on port {port!r}" if port else "")
            print(f"No connected gamepad matches {description}.")
            return 1
        selection = matches[0].as_selection(
            pin_identity=True, pin_port=bool(port)
        )
    elif guid:
        matching_gamepad = next(
            (
                gamepad
                for gamepad in SDLGamepad.list_available_gamepads()
                if gamepad.guid.lower() == guid.lower()
            ),
            None,
        )
        if matching_gamepad is not None:
            selection = matching_gamepad.as_selection(
                pin_identity=True, pin_port=bool(port)
            )
        else:
            selection = GamepadSelection(guid=guid, port=port or "")
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


def _active_argument_labels(flag_labels: list[tuple[bool, str]]) -> list[str]:
    return [label for is_active, label in flag_labels if is_active]


def _validate_mode_combination(
    args: argparse.Namespace, parser: argparse.ArgumentParser
) -> None:
    has_criteria = bool(
        args.gamepad_guid or args.gamepad_name or args.gamepad_port
    )
    selection_labels = _active_argument_labels(
        [
            (args.list_gamepads, "--list-gamepads"),
            (args.any_gamepad, "--any-gamepad"),
            (args.select_gamepad, "--select-gamepad"),
            (has_criteria, "--gamepad-guid/name/port"),
            (args.port is not None, "--port"),
        ]
    )
    run_labels = _active_argument_labels(
        [
            (args.headless, "--headless"),
            (args.hide, "--hide"),
            (args.lan, "--lan"),
            (args.terminal, "--terminal"),
        ]
    )

    if len(selection_labels) > 1:
        parser.error(
            f"these arguments cannot be combined: {', '.join(selection_labels)}"
        )
    if selection_labels and run_labels:
        parser.error(
            f"selection arguments ({', '.join(selection_labels)}) cannot be"
            f" combined with run arguments ({', '.join(run_labels)})"
        )


def _run_selection_mode(
    args: argparse.Namespace,
    parser: argparse.ArgumentParser,
    config_path: Path,
) -> int | None:
    """Handle a selection-mode argument, or return None if none is active."""
    if args.list_gamepads:
        return _print_available_gamepads()
    if args.any_gamepad:
        GamepadSelection.clear(config_path)
        print("Will use any gamepad.")
        return 0
    if args.select_gamepad:
        return _select_and_save_gamepad(config_path)
    if args.gamepad_guid or args.gamepad_name or args.gamepad_port:
        return _save_gamepad_by_criteria(
            guid=args.gamepad_guid,
            name=args.gamepad_name,
            port=args.gamepad_port,
            config_path=config_path,
        )
    if args.port is not None:
        if not (MIN_PORT <= args.port <= MAX_PORT):
            parser.error(f"--port must be between {MIN_PORT} and {MAX_PORT}")
        save_server_port(args.port, config_path)
        print(f"Server port set to {args.port}.")
        return 0
    return None


def main(argv: Sequence[str] | None = None) -> int:
    parser = _build_parser()
    args = parser.parse_args(args=argv)
    configure_logging(args)

    config_path = _config_path()
    _validate_mode_combination(args, parser)

    selection_result = _run_selection_mode(args, parser, config_path)
    if selection_result is not None:
        return selection_result

    if not args.headless:
        return _run_tray(args, config_path)
    return _run_headless_server(args, config_path)


def _prompt_match_criteria(
    selected_gamepad: GamepadInfo,
) -> GamepadSelection | None:
    """Ask how to match a chosen gamepad; return None if the user cancels."""
    pin_identity = True
    pin_port = False
    if selected_gamepad.port:
        port_label = port_display_name(selected_gamepad.port)
        print("  Match by:")
        print("    1) Gamepad identity only (any port)")
        print(f"    2) Physical port only ({port_label})")
        print("    3) Both identity and physical port")
        while True:
            try:
                match_choice = input("  Choose [1]: ").strip()
            except KeyboardInterrupt:
                print()
                return None
            if match_choice in ("", "1"):
                break
            if match_choice == "2":
                pin_identity = False
                pin_port = True
                break
            if match_choice == "3":
                pin_port = True
                break
            print("  Enter 1, 2, or 3.")
    return selected_gamepad.as_selection(
        pin_identity=pin_identity, pin_port=pin_port
    )


def _interactive_select_gamepad() -> GamepadSelection | None:
    gamepads = SDLGamepad.list_available_gamepads()
    if not gamepads:
        print("No compatible gamepads detected.")
        return None
    print("Detected gamepads:")
    for menu_number, gamepad in enumerate(gamepads, start=1):
        print(f"  {menu_number}) {_gamepad_label(gamepad)}")
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
        selected_number = int(choice)
        if selected_number == 0:
            return GamepadSelection()
        if 1 <= selected_number <= len(gamepads):
            return _prompt_match_criteria(gamepads[selected_number - 1])
        print("Selection out of range.")

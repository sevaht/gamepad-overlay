"""Reading and writing the application's JSON configuration file.

The config file is a single JSON object whose top-level keys are independent
sections (``selection``, ``server``, ``overlay``). Every reader/writer in the
app goes through these helpers so the read-merge-write behavior and the
"missing or corrupt file behaves like an empty config" policy live in one
place.
"""

from __future__ import annotations

import json
import logging
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from collections.abc import Mapping
    from pathlib import Path

CONFIG_FILE_NAME = "config.json"

logger = logging.getLogger(__name__)


def read_config(config_path: Path) -> dict[str, object]:
    """Return the parsed config object, or an empty dict if missing/invalid."""
    try:
        parsed_config = json.loads(config_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {}
    return parsed_config if isinstance(parsed_config, dict) else {}


def write_config(config_path: Path, config: dict[str, object]) -> None:
    """Write the whole config object, creating parent directories as needed."""
    config_path.parent.mkdir(parents=True, exist_ok=True)
    config_path.write_text(
        json.dumps(config, indent=2) + "\n", encoding="utf-8"
    )


def read_section(config_path: Path, section_name: str) -> dict[str, object]:
    """Return the named section as a dict, or an empty dict if absent."""
    section = read_config(config_path).get(section_name)
    return section if isinstance(section, dict) else {}


def update_section(
    config_path: Path, section_name: str, section_data: Mapping[str, object]
) -> None:
    """Replace one section, preserving every other section in the file."""
    config = read_config(config_path)
    config[section_name] = dict(section_data)
    write_config(config_path, config)


def remove_section(config_path: Path, section_name: str) -> None:
    """Delete one section if present, preserving every other section."""
    config = read_config(config_path)
    if section_name in config:
        del config[section_name]
        write_config(config_path, config)

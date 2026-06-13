from __future__ import annotations

from functools import cache
from typing import TYPE_CHECKING

from platformdirs import PlatformDirs

if TYPE_CHECKING:
    from pathlib import Path

APP_NAME = "gamepad-overlay"
APP_AUTHOR = "sevaht"


@cache
def user_config_path() -> Path:
    path = PlatformDirs(APP_NAME, appauthor=APP_AUTHOR).user_config_path
    # platformdirs omits appauthor from the path on non-Windows platforms;
    # insert it so all platforms use <author>/<appname>.
    if path.parent.name != APP_AUTHOR:
        path = path.parent / APP_AUTHOR / APP_NAME
    return path

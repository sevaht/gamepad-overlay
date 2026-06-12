from __future__ import annotations

from functools import cache

from platformdirs import PlatformDirs

APP_NAME = "gamepad-overlay"
APP_AUTHOR = "sevaht"


@cache
def platform_dirs() -> PlatformDirs:
    return PlatformDirs(APP_NAME, appauthor=APP_AUTHOR)

from __future__ import annotations

import logging
from typing import TextIO


def announce(
    message: str,
    logger: logging.Logger | None,
    *,
    log: bool = True,
    level: int = logging.INFO,
    file: TextIO | None = None,
) -> None:
    print(message, file=file)
    if log and logger is not None:
        logger.log(level, message)

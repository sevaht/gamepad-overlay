from __future__ import annotations

import logging


def announce(
    message: str, logger: logging.Logger | None, *, level: int = logging.INFO
) -> None:
    """Print a message to stdout and, if a logger is given, log it too."""
    print(message)
    if logger is not None:
        logger.log(level, message)

from typing import Any

class ClientMessage:
    def __init__(
        self,
        *,
        type: int = ...,
        client_type: int = ...,
        window: int = ...,
        data: Any = ...,
    ) -> None: ...

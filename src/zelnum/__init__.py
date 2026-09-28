"""Official Python SDK for the Zelnum phone & email verification API.

Zelnum — https://zelnum.com — tells you whether a phone number or email
address is registered on messaging platforms and services, synchronously in
realtime or as an asynchronous bulk task for large lists.

- Official website: https://zelnum.com
- Full API reference: https://docs.zelnum.com
"""

from __future__ import annotations

from .client import Zelnum
from .exceptions import (
    AuthenticationError,
    ConflictError,
    InsufficientBalanceError,
    NetworkError,
    NotFoundError,
    ProtocolError,
    RateLimitError,
    ResultExpiredError,
    ResultNotReadyError,
    ResultUnavailableError,
    ServerError,
    ValidationError,
    ZelnumError,
)

__version__ = "0.1.1"

__all__ = [
    "Zelnum",
    "ZelnumError",
    "NetworkError",
    "ProtocolError",
    "AuthenticationError",
    "InsufficientBalanceError",
    "ValidationError",
    "NotFoundError",
    "ConflictError",
    "RateLimitError",
    "ResultExpiredError",
    "ResultNotReadyError",
    "ResultUnavailableError",
    "ServerError",
    "__version__",
]

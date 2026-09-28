"""Zelnum exceptions.

API and network errors derive from :class:`ZelnumError`. Invalid local arguments
raise ValueError; file operations can raise OSError. Subclasses mirror HTTP status
codes documented at https://docs.zelnum.com.
"""

from __future__ import annotations

from typing import Any, Optional


class ZelnumError(Exception):
    """Base class for all Zelnum SDK errors."""

    def __init__(
        self,
        message: str,
        *,
        status: Optional[int] = None,
        code: Optional[str] = None,
        errors: Optional[dict[str, Any]] = None,
        body: Any = None,
    ) -> None:
        super().__init__(message)
        self.message = message
        self.status = status
        self.code = code
        self.errors = errors
        self.body = body
        self.retry_after: Optional[str] = None

    def __str__(self) -> str:  # pragma: no cover - cosmetic
        parts = [self.message]
        if self.status is not None:
            parts.append(f"HTTP {self.status}")
        if self.code is not None:
            parts.append(f"code={self.code}")
        return " | ".join(parts)


class NetworkError(ZelnumError):
    """The request could not reach the API (connection failure or timeout)."""


class ProtocolError(ZelnumError):
    """The API returned an unexpected redirect or non-object JSON response."""


class AuthenticationError(ZelnumError):
    """HTTP 401 - the API key is missing, malformed or revoked."""


class InsufficientBalanceError(ZelnumError):
    """HTTP 402 - the account balance cannot cover this request."""


class ValidationError(ZelnumError):
    """HTTP 400/422 - the request was rejected by input validation."""


class NotFoundError(ZelnumError):
    """HTTP 404 - the task or resource does not exist."""


class ConflictError(ZelnumError):
    """HTTP 409 - idempotency conflict or the request is still in flight."""


class RateLimitError(ZelnumError):
    """HTTP 429 - too many requests; retry after the advertised window."""


class ResultNotReadyError(ZelnumError):
    """The result is not ready; check task status before polling again."""


class ResultUnavailableError(ZelnumError):
    """The result is unavailable; waiting alone may not resolve the failure."""


class ResultExpiredError(ResultUnavailableError):
    """The result file has expired; polling will not restore it."""


class ServerError(ZelnumError):
    """HTTP 5xx - the API or an upstream detection route failed."""


_STATUS_MAP = {
    400: ValidationError,
    401: AuthenticationError,
    402: InsufficientBalanceError,
    404: NotFoundError,
    409: ConflictError,
    422: ValidationError,
    429: RateLimitError,
}


def error_for_status(
    status: int,
    body: Any,
    *,
    result_not_ready: bool = False,
) -> ZelnumError:
    """Map an HTTP status + JSON body to the matching exception type."""
    code = None
    message = None
    errors = None
    if isinstance(body, dict):
        code = body.get("code")
        message = body.get("message")
        errors = body.get("errors")

    if result_not_ready and status == 422:
        # Current TaskController responses contain only a message, no code.
        # Match its known messages exactly; do not label every 422 retryable.
        # Prefer a structured code when present, including unknown codes.
        if code is not None:
            exc_cls = {
                "result_not_ready": ResultNotReadyError,
                "result_expired": ResultExpiredError,
            }.get(code, ResultUnavailableError)
        else:
            exc_cls = {
                "Task is not yet completed.": ResultNotReadyError,
                "Result file has not been generated.": ResultNotReadyError,
                "Result file has expired.": ResultExpiredError,
            }.get(message, ResultUnavailableError)
    else:
        exc_cls = _STATUS_MAP.get(status)
    if exc_cls is None:
        if status >= 500:
            exc_cls = ServerError
        else:
            exc_cls = ZelnumError
    return exc_cls(
        message or f"Zelnum API returned HTTP {status}",
        status=status,
        code=code,
        errors=errors,
        body=body,
    )

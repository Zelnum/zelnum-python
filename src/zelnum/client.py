from __future__ import annotations

import re
import uuid
from pathlib import Path
from typing import Any, Optional, Union

import httpx

from .exceptions import NetworkError, ProtocolError, error_for_status

DEFAULT_BASE_URL = "https://api.zelnum.com/api/v1"

_SERIES = ("phone", "email")


class Zelnum:
    """Synchronous client for the Zelnum Detection API.

    Example::

        from zelnum import Zelnum

        client = Zelnum("YOUR_API_KEY")
        balance = client.get_balance()
        products = client.list_products()
    """

    def __init__(
        self,
        api_key: str,
        *,
        base_url: str = DEFAULT_BASE_URL,
        timeout: float = 30.0,
        http_client: Optional[httpx.Client] = None,
    ) -> None:
        if not api_key:
            raise ValueError("api_key must not be empty")
        self._api_key = api_key
        self._base_url = base_url.rstrip("/")
        self._timeout = timeout
        self._owns_client = http_client is None
        self._client = http_client if http_client is not None else httpx.Client()

    @staticmethod
    def _user_agent_version() -> str:
        from . import __version__

        return __version__

    # ------------------------------------------------------------------
    # Lifecycle
    # ------------------------------------------------------------------

    def close(self) -> None:
        """Close SDK-owned connections; a supplied HTTP client remains open."""
        if self._owns_client:
            self._client.close()

    def __enter__(self) -> "Zelnum":
        return self

    def __exit__(self, *exc_info: Any) -> None:
        self.close()

    # ------------------------------------------------------------------
    # Common
    # ------------------------------------------------------------------

    def list_products(self) -> dict[str, Any]:
        """List active products. Returns ``{"data": [Product, ...]}``."""
        return self._request("GET", "/products")

    def get_balance(self) -> dict[str, Any]:
        """Get the current account balance (a string, e.g. ``{"balance": "5.230000"}``)."""
        return self._request("GET", "/balance")

    def get_api_key(self) -> dict[str, Any]:
        """Get the account's latest active API key metadata (not its secret)."""
        return self._request("GET", "/api-key")

    # ------------------------------------------------------------------
    # Realtime
    # ------------------------------------------------------------------

    def quote_realtime(
        self,
        identifier: str,
        product_ids: list[int],
        *,
        series: str = "phone",
        country: Optional[str] = None,
    ) -> dict[str, Any]:
        """Get a price quote for a realtime check without executing it."""
        self._validate_series(series)
        self._validate_product_ids(product_ids)
        return self._request(
            "POST",
            f"/realtime/quote/{series}",
            json_body={
                "identifier": identifier,
                "country": country,
                "product_ids": list(product_ids),
            },
        )

    def check_realtime(
        self,
        identifier: str,
        product_ids: list[int],
        *,
        series: str = "phone",
        country: Optional[str] = None,
        idempotency_key: Optional[str] = None,
        quote_token: Optional[str] = None,
        quoted_total: Optional[Union[str, float]] = None,
    ) -> dict[str, Any]:
        """Check one identifier against up to 10 realtime products.

        ``idempotency_key`` is required by the API; when omitted the SDK
        generates a fresh UUID. Pass a stable key to make retries safe.
        """
        self._validate_series(series)
        self._validate_product_ids(product_ids)
        return self._request(
            "POST",
            f"/realtime/check/{series}",
            json_body={
                "identifier": identifier,
                "country": country,
                "product_ids": list(product_ids),
            },
            idempotency_key=idempotency_key if idempotency_key is not None else str(uuid.uuid4()),
            quote_token=quote_token,
            quoted_total=quoted_total,
        )

    # ------------------------------------------------------------------
    # Bulk
    # ------------------------------------------------------------------

    def quote_bulk(
        self,
        product: str,
        phones: list[str],
        *,
        country: Optional[str] = None,
    ) -> dict[str, Any]:
        """Quote up to 10,000 phone/email identifiers without submitting them."""
        self._validate_identifiers(phones)
        if len(phones) > 10_000:
            raise ValueError("bulk quotes accept at most 10,000 identifiers")
        return self._request(
            "POST",
            "/quotes/bulk",
            json_body={"product": product, "phones": list(phones), "country": country},
        )

    def create_bulk_task(
        self,
        product: str,
        phones: list[str],
        *,
        country: Optional[str] = None,
        idempotency_key: Optional[str] = None,
        quote_token: Optional[str] = None,
        quoted_total: Optional[Union[str, float]] = None,
    ) -> dict[str, Any]:
        """Submit a bulk detection task for phone numbers or email addresses.

        Phone products require ``country`` (ISO 3166-1 alpha-2, e.g. ``"BR"``).
        Email products must omit it. Returns ``{"task_id": "...", ...}``.
        """
        self._validate_identifiers(phones)
        return self._request(
            "POST",
            "/detect",
            json_body={"product": product, "phones": list(phones), "country": country},
            idempotency_key=idempotency_key if idempotency_key is not None else str(uuid.uuid4()),
            quote_token=quote_token,
            quoted_total=quoted_total,
        )

    def create_bulk_task_from_file(
        self,
        product: str,
        file_path: str,
        *,
        country: Optional[str] = None,
        idempotency_key: Optional[str] = None,
    ) -> dict[str, Any]:
        """Submit a bulk detection task from a file (one identifier per line)."""
        with open(file_path, "rb") as fh:
            return self._request(
                "POST",
                "/detect/file",
                files={"file": (Path(file_path).name, fh)},
                data={"product": product, "country": country},
                idempotency_key=idempotency_key if idempotency_key is not None else str(uuid.uuid4()),
            )

    def get_task_status(self, task_id: str) -> dict[str, Any]:
        """Get progress and counters for a bulk task."""
        return self._request("GET", f"/tasks/{task_id}")

    def get_task_result(self, task_id: str) -> dict[str, Any]:
        """Get result metadata (including a download URL) for a finished task.

        Raises :class:`ResultNotReadyError` when the API reports a pending
        result, :class:`ResultExpiredError` for an expired file, or
        :class:`ResultUnavailableError` for other result-unavailable responses.
        Check task status before polling again: failed tasks cannot complete.
        """
        return self._request("GET", f"/tasks/{task_id}/result")

    def download_task_result(self, task_id: str) -> bytes:
        """Download the finished task result (ZIP archive or CSV) as bytes."""
        request = self._build_request("GET", f"/tasks/{task_id}/download")
        response = self._send(request)
        return response.content

    # ------------------------------------------------------------------
    # Internals
    # ------------------------------------------------------------------

    @staticmethod
    def _validate_series(series: str) -> None:
        if series not in _SERIES:
            raise ValueError(f"series must be one of {_SERIES}, got {series!r}")

    def _request(
        self,
        method: str,
        path: str,
        *,
        json_body: Optional[dict[str, Any]] = None,
        idempotency_key: Optional[str] = None,
        quote_token: Optional[str] = None,
        quoted_total: Optional[Union[str, float]] = None,
        files: Optional[dict[str, Any]] = None,
        data: Optional[dict[str, Any]] = None,
    ) -> dict[str, Any]:
        headers: dict[str, str] = {}
        if idempotency_key is not None:
            if not re.fullmatch(r"[A-Za-z0-9._:-]{1,128}", idempotency_key):
                raise ValueError("idempotency_key must be 1-128 letters, digits, '.', '_', ':', or '-'")
            headers["Idempotency-Key"] = idempotency_key
        if (quote_token is None) != (quoted_total is None):
            raise ValueError("quote_token and quoted_total must be supplied together")
        if quote_token is not None:
            headers["X-ZelNum-Quote"] = quote_token
        if quote_token is not None and quoted_total is not None:
            headers["X-ZelNum-Quote-Amount"] = str(quoted_total)

        request = self._build_request(
            method,
            path,
            json={k: v for k, v in json_body.items() if v is not None} if json_body is not None else None,
            files=files,
            data={k: v for k, v in data.items() if v is not None} if data is not None else None,
            headers=headers,
        )
        response = self._send(request)
        try:
            body: Any = response.json() if response.content else None
        except ValueError as exc:
            raise ProtocolError("Expected a JSON object from the API", status=response.status_code) from exc
        if not isinstance(body, dict):
            raise ProtocolError("Expected a JSON object from the API", status=response.status_code)
        return body

    def _send(self, request: httpx.Request) -> httpx.Response:
        try:
            # Never forward credentials to a redirect destination.
            response = self._client.send(request, follow_redirects=False)
        except httpx.TimeoutException as exc:
            raise NetworkError(
                f"Zelnum API request timed out after {self._timeout}s",
            ) from exc
        except httpx.HTTPError as exc:
            raise NetworkError(f"Zelnum API request failed: {exc}") from exc

        if 300 <= response.status_code < 400:
            raise ProtocolError("Unexpected API redirect", status=response.status_code)
        if response.status_code >= 400:
            try:
                body: Any = response.json() if response.content else None
            except ValueError:
                body = {"raw": response.text[:1000]}
            result_not_ready = request.url.path.endswith("/result")
            error = error_for_status(
                response.status_code, body, result_not_ready=result_not_ready
            )
            error.retry_after = response.headers.get("Retry-After")
            raise error
        return response

    @staticmethod
    def _validate_product_ids(product_ids: list[int]) -> None:
        if not 1 <= len(product_ids) <= 10:
            raise ValueError("product_ids must contain 1-10 product IDs")
        if any(type(value) is not int or value <= 0 for value in product_ids):
            raise ValueError("product_ids must be positive integers")
        if len(set(product_ids)) != len(product_ids):
            raise ValueError("product_ids must be unique")

    @staticmethod
    def _validate_identifiers(identifiers: list[str]) -> None:
        if isinstance(identifiers, (str, bytes)) or not identifiers:
            raise ValueError("phones must be a nonempty list of phone/email identifiers")
        if any(not isinstance(value, str) or not value.strip() for value in identifiers):
            raise ValueError("each phone/email identifier must be a nonempty string")

    def _build_request(self, method: str, path: str, **kwargs: Any) -> httpx.Request:
        headers = {
            "X-API-Key": self._api_key,
            "Accept": "application/json",
            "User-Agent": f"zelnum-python/{self._user_agent_version()}",
            **kwargs.pop("headers", {}),
        }
        return self._client.build_request(
            method, self._base_url + path, headers=headers,
            timeout=self._timeout, **kwargs,
        )

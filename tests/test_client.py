from __future__ import annotations

import httpx
import pytest
import respx

from zelnum import (
    AuthenticationError,
    RateLimitError,
    ResultNotReadyError,
    Zelnum,
    ZelnumError,
)

BASE = "https://api.zelnum.com/api/v1"


@pytest.fixture()
def client() -> Zelnum:
    with Zelnum("zn_test_key", base_url=BASE) as instance:
        yield instance


@respx.mock
def test_get_balance(client: Zelnum) -> None:
    route = respx.get(f"{BASE}/balance").mock(
        return_value=httpx.Response(200, json={"balance": "5.230000"})
    )
    assert client.get_balance() == {"balance": "5.230000"}
    assert route.called
    assert route.calls.last.request.headers["X-API-Key"] == "zn_test_key"


@respx.mock
def test_check_realtime_auto_idempotency_key(client: Zelnum) -> None:
    route = respx.post(f"{BASE}/realtime/check/phone").mock(
        return_value=httpx.Response(200, json={"request_id": "abc", "results": []})
    )
    result = client.check_realtime("+14155550101", [101], country="US")
    assert result["request_id"] == "abc"
    headers = route.calls.last.request.headers
    assert len(headers["Idempotency-Key"]) == 36  # UUID
    body = route.calls.last.request.read().decode()
    assert "+14155550101" in body
    assert "101" in body


@respx.mock
def test_check_realtime_explicit_idempotency_and_quote(client: Zelnum) -> None:
    route = respx.post(f"{BASE}/realtime/check/phone").mock(
        return_value=httpx.Response(200, json={"request_id": "abc"})
    )
    client.check_realtime(
        "+14155550101",
        [101],
        idempotency_key="my-key-1",
        quote_token="qt_123",
        quoted_total=0.5,
    )
    headers = route.calls.last.request.headers
    assert headers["Idempotency-Key"] == "my-key-1"
    assert headers["X-ZelNum-Quote"] == "qt_123"
    assert headers["X-ZelNum-Quote-Amount"] == "0.5"


@respx.mock
def test_check_realtime_rejects_more_than_ten_products(client: Zelnum) -> None:
    with pytest.raises(ValueError):
        client.check_realtime("+14155550101", list(range(1, 12)))


@respx.mock
def test_401_raises_authentication_error(client: Zelnum) -> None:
    respx.get(f"{BASE}/balance").mock(
        return_value=httpx.Response(
            401, json={"code": "unauthorized", "message": "Missing or invalid API key"}
        )
    )
    with pytest.raises(AuthenticationError) as excinfo:
        client.get_balance()
    assert excinfo.value.status == 401
    assert excinfo.value.code == "unauthorized"


@respx.mock
def test_429_raises_rate_limit_error(client: Zelnum) -> None:
    respx.get(f"{BASE}/balance").mock(
        return_value=httpx.Response(429, json={"code": "rate_limited", "message": "Slow down"})
    )
    with pytest.raises(RateLimitError):
        client.get_balance()


@respx.mock
def test_task_result_not_ready(client: Zelnum) -> None:
    respx.get(f"{BASE}/tasks/tok123/result").mock(
        return_value=httpx.Response(
            422, json={"code": "result_not_ready", "message": "Task is not complete"}
        )
    )
    with pytest.raises(ResultNotReadyError):
        client.get_task_result("tok123")


@respx.mock
def test_download_task_result_returns_bytes(client: Zelnum) -> None:
    respx.get(f"{BASE}/tasks/tok123/download").mock(
        return_value=httpx.Response(200, content=b"ZIPDATA")
    )
    assert client.download_task_result("tok123") == b"ZIPDATA"


@respx.mock
def test_create_bulk_task_from_file(client: Zelnum, tmp_path) -> None:
    list_file = tmp_path / "numbers.txt"
    list_file.write_text("+5215512345678\n+5215512345679\n")
    route = respx.post(f"{BASE}/detect/file").mock(
        return_value=httpx.Response(202, json={"mode": "async", "task_id": "t1"})
    )
    result = client.create_bulk_task_from_file(
        "whatsapp-bulk", str(list_file), country="MX"
    )
    assert result["task_id"] == "t1"
    content = route.calls.last.request.content
    assert b"numbers.txt" in content
    assert b"+5215512345678" in content


@respx.mock
def test_quote_realtime(client: Zelnum) -> None:
    route = respx.post(f"{BASE}/realtime/quote/email").mock(
        return_value=httpx.Response(200, json={"quote": {"quote_token": "qt_1", "total": 0.02}})
    )
    result = client.quote_realtime("user@example.com", [201], series="email")
    assert result["quote"]["quote_token"] == "qt_1"
    assert "realtime/quote/email" in str(route.calls.last.request.url)


@respx.mock
def test_all_errors_derive_from_base(client: Zelnum) -> None:
    respx.get(f"{BASE}/api-key").mock(
        return_value=httpx.Response(500, json={"code": "server_error", "message": "boom"})
    )
    with pytest.raises(ZelnumError):
        client.get_api_key()


def test_cli_accepts_api_key_after_subcommand() -> None:
    from zelnum.cli import build_parser

    args = build_parser().parse_args(["balance", "--api-key", "zn_k"])
    assert getattr(args, "api_key") == "zn_k"

    args2 = build_parser().parse_args(["--api-key", "zn_k", "check", "+123", "--products", "1"])
    assert getattr(args2, "api_key") == "zn_k"
    assert args2.command == "check"

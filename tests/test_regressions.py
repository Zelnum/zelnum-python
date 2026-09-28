from __future__ import annotations

import json
import runpy
from pathlib import Path

import httpx
import pytest
import respx

from zelnum import NetworkError, ProtocolError, ValidationError, Zelnum
from zelnum.cli import main

BASE = "https://api.zelnum.com/api/v1"
ROOT = Path(__file__).resolve().parents[1]
QUOTE = {"quote": {"quote_token": "qt_test", "total": "0.020000", "currency": "USDT"}}


@pytest.fixture
def client():
    with Zelnum("zn_test_key") as instance:
        yield instance


@pytest.mark.parametrize("method", ["quote_realtime", "check_realtime"])
@pytest.mark.parametrize("ids", [[], list(range(1, 12)), [1, 1], [0], [-1], [True], ["1"]])
@respx.mock
def test_product_validation_before_network(client, method, ids):
    with pytest.raises(ValueError):
        getattr(client, method)("+14155550101", ids)
    assert not respx.calls


@pytest.mark.parametrize("method", ["quote_bulk", "create_bulk_task"])
@pytest.mark.parametrize("values", [[], [""], [" "], [Ellipsis], "user@example.com"])
@respx.mock
def test_bulk_input_validation(client, method, values):
    with pytest.raises(ValueError):
        getattr(client, method)("email-bulk", values)
    assert not respx.calls


def test_bulk_quote_limit(client):
    with pytest.raises(ValueError, match="10,000"):
        client.quote_bulk("phone-bulk", ["+14155550101"] * 10001)


@pytest.mark.parametrize("path,invoke", [
    ("/realtime/check/email", lambda c: c.check_realtime("user@example.com", [54], series="email")),
    ("/realtime/quote/email", lambda c: c.quote_realtime("user@example.com", [54], series="email")),
    ("/quotes/bulk", lambda c: c.quote_bulk("email-bulk", ["user@example.com"])),
    ("/detect", lambda c: c.create_bulk_task("email-bulk", ["user@example.com"])),
])
@respx.mock
def test_email_omits_country(client, path, invoke):
    route = respx.post(BASE + path).respond(200, json={"ok": True})
    invoke(client)
    assert "country" not in json.loads(route.calls.last.request.content)


@respx.mock
def test_bulk_quote_and_same_key_replay(client):
    quote_route = respx.post(BASE + "/quotes/bulk").respond(200, json=QUOTE)
    submit_route = respx.post(BASE + "/detect").respond(202, json={"task_id": "t1"})
    quote = client.quote_bulk("phone-bulk", ["+14155550101"], country="US")["quote"]
    for _ in range(2):
        assert client.create_bulk_task(
            "phone-bulk", ["+14155550101"], country="US", idempotency_key="saved-key",
            quote_token=quote["quote_token"], quoted_total=quote["total"],
        )["task_id"] == "t1"
    assert quote_route.called
    for call in submit_route.calls:
        assert call.request.headers["Idempotency-Key"] == "saved-key"
        assert call.request.headers["X-ZelNum-Quote"] == "qt_test"
        assert call.request.headers["X-ZelNum-Quote-Amount"] == "0.020000"


@respx.mock
def test_file_email_country_and_idempotency(client, tmp_path):
    file = tmp_path / "emails.txt"
    file.write_text("user@example.com\n", encoding="utf-8")
    route = respx.post(BASE + "/detect/file").respond(202, json={"task_id": "t1"})
    client.create_bulk_task_from_file("email-bulk", str(file), idempotency_key="file-key")
    request = route.calls.last.request
    assert request.headers["Idempotency-Key"] == "file-key"
    assert b'name="country"' not in request.content
    assert b'filename="emails.txt"' in request.content
    assert str(tmp_path).encode() not in request.content


@respx.mock
def test_new_calls_have_new_keys(client):
    route = respx.post(BASE + "/detect").respond(202, json={"task_id": "t1"})
    client.create_bulk_task("email-bulk", ["user@example.com"])
    client.create_bulk_task("email-bulk", ["user@example.com"])
    assert route.calls[0].request.headers["Idempotency-Key"] != route.calls[1].request.headers["Idempotency-Key"]


@pytest.mark.parametrize("kwargs", [{"quote_token": "token"}, {"quoted_total": "1.000000"}, {"idempotency_key": ""}, {"idempotency_key": "bad key"}, {"idempotency_key": "a" * 129}])
@pytest.mark.parametrize("method", ["realtime", "bulk"])
@respx.mock
def test_bad_submission_headers(client, kwargs, method):
    with pytest.raises(ValueError):
        if method == "realtime":
            client.check_realtime("+14155550101", [1], **kwargs)
        else:
            client.create_bulk_task("phone-bulk", ["+14155550101"], **kwargs)
    assert not respx.calls


@respx.mock
def test_normal_422_is_validation_error(client):
    respx.post(BASE + "/detect").respond(422, json={"message": "Invalid input", "errors": {"country": ["Required"]}})
    with pytest.raises(ValidationError) as error:
        client.create_bulk_task("phone-bulk", ["+14155550101"])
    assert error.value.errors == {"country": ["Required"]}


@respx.mock
def test_retry_after_preserved(client):
    respx.get(BASE + "/balance").respond(429, json={"message": "Slow down"}, headers={"Retry-After": "60"})
    from zelnum import RateLimitError
    with pytest.raises(RateLimitError) as error:
        client.get_balance()
    assert error.value.retry_after == "60"


@pytest.mark.parametrize("endpoint", ["balance", "download"])
def test_borrowed_http_client_auth_url_timeout_and_ownership(endpoint):
    requests = []
    def handler(request):
        requests.append(request)
        return httpx.Response(200, json={"balance": "5"}) if endpoint == "balance" else httpx.Response(200, content=b"ZIP")
    with httpx.Client(base_url="https://unrelated.invalid", transport=httpx.MockTransport(handler)) as borrowed:
        with Zelnum("zn_ours", base_url="https://api.example.test/v1", timeout=12, http_client=borrowed) as client:
            if endpoint == "balance":
                assert client.get_balance() == {"balance": "5"}
            else:
                assert client.download_task_result("t1") == b"ZIP"
        assert not borrowed.is_closed
    request = requests[0]
    assert str(request.url).startswith("https://api.example.test/v1/")
    assert request.headers["X-API-Key"] == "zn_ours"
    assert request.headers["User-Agent"].startswith("zelnum-python/")
    assert request.extensions["timeout"]["read"] == 12


def test_owned_client_is_closed():
    with Zelnum("zn_key") as client:
        assert not client._client.is_closed
    assert client._client.is_closed


@pytest.mark.parametrize("status,content", [(200, b"<html>error</html>"), (200, b"[]"), (200, b"null"), (204, b""), (302, b"")])
@respx.mock
def test_unexpected_response_is_not_success(client, status, content):
    route = respx.get(BASE + "/balance").respond(status, content=content, headers={"Location": "https://other.invalid"})
    with pytest.raises(ProtocolError):
        client.get_balance()
    assert route.call_count == 1


@respx.mock
def test_timeout_not_retried(client):
    route = respx.post(BASE + "/realtime/check/phone").mock(side_effect=httpx.ReadTimeout("timeout"))
    with pytest.raises(NetworkError):
        client.check_realtime("+14155550101", [1], idempotency_key="saved")
    assert route.call_count == 1


@pytest.mark.parametrize("products", ["", "abc", "0", "1,1", "1,2,3,4,5,6,7,8,9,10,11"])
@respx.mock
def test_cli_invalid_products_no_traceback(products, capsys):
    assert main(["check", "+14155550101", "--products", products, "--api-key", "zn_test"]) == 2
    assert "Error:" in capsys.readouterr().err
    assert not respx.calls


@respx.mock
def test_cli_check_passes_idempotency():
    route = respx.post(BASE + "/realtime/check/phone").respond(200, json={"results": []})
    assert main(["check", "+14155550101", "--products", "1", "--api-key", "zn_test", "--idempotency-key", "saved-key"]) == 0
    assert route.calls.last.request.headers["Idempotency-Key"] == "saved-key"


@respx.mock
def test_cli_download_file_error(tmp_path, capsys):
    respx.get(BASE + "/tasks/t1/download").respond(200, content=b"ZIP")
    assert main(["download", "t1", "--api-key", "zn_test", "-o", str(tmp_path)]) == 2
    assert "Error:" in capsys.readouterr().err


@pytest.mark.parametrize("series", ["phone", "email"])
@pytest.mark.parametrize("execute", [False, True])
@respx.mock
def test_quickstart_example(monkeypatch, series, execute):
    monkeypatch.setenv("ZELNUM_API_KEY", "zn_test")
    respx.get(BASE + "/products").respond(200, json={"data": [{"id": 47, "mode": "realtime", "series": series}]})
    respx.post(BASE + f"/realtime/quote/{series}").respond(200, json=QUOTE)
    route = respx.post(BASE + f"/realtime/check/{series}").respond(200, json={"results": []})
    args = ["user@example.com" if series == "email" else "+14155550101", "--products", "47", "--series", series]
    if execute:
        args += ["--execute", "--idempotency-key", "example-key"]
    example = runpy.run_path(str(ROOT / "examples/quickstart.py"))
    assert example["main"](args) == 0
    assert route.called == execute
    if execute:
        assert route.calls.last.request.headers["X-ZelNum-Quote"] == "qt_test"


@pytest.mark.parametrize("series", ["phone", "email"])
@pytest.mark.parametrize("outcome", ["quote", "completed", "failed", "timeout"])
@respx.mock
def test_bulk_example(monkeypatch, tmp_path, capsys, series, outcome):
    monkeypatch.setenv("ZELNUM_API_KEY", "zn_test")
    file = tmp_path / "identifiers.txt"
    file.write_text("user@example.com\n" if series == "email" else "+14155550101\n")
    output = tmp_path / "result.zip"
    respx.get(BASE + "/products").respond(200, json={"data": [{"slug": "bulk-product", "mode": "async", "series": series, "min_phones": 1}]})
    respx.post(BASE + "/quotes/bulk").respond(200, json=QUOTE)
    submit = respx.post(BASE + "/detect").respond(202, json={"task_id": "t1"})
    respx.get(BASE + "/tasks/t1").respond(200, json={"status": outcome, "result_available": outcome == "completed"})
    respx.get(BASE + "/tasks/t1/download").respond(200, content=b"ZIP")
    args = [str(file), "--product", "bulk-product", "--output", str(output)]
    if series == "phone":
        args += ["--country", "US"]
    if outcome != "quote":
        args += ["--execute", "--idempotency-key", "bulk-example"]
    example = runpy.run_path(str(ROOT / "examples/bulk.py"))
    if outcome == "timeout":
        moments = iter([0, 0, 301, 301])
        monkeypatch.setattr(example["time"], "monotonic", lambda: next(moments))
        monkeypatch.setattr(example["time"], "sleep", lambda seconds: None)
    assert example["main"](args) == {"quote": 0, "completed": 0, "failed": 1, "timeout": 2}[outcome]
    assert submit.called == (outcome != "quote")
    if outcome == "completed":
        assert output.read_bytes() == b"ZIP"
    if outcome == "timeout":
        assert "NOT cancelled" in capsys.readouterr().out


def test_readme_python_examples(monkeypatch, tmp_path):
    """Run the actual README code blocks against contract-shaped responses."""
    import re
    monkeypatch.chdir(tmp_path)
    for key, value in {"ZELNUM_API_KEY": "zn_test", "ZELNUM_PRODUCT_ID": "47", "ZELNUM_IDENTIFIER": "+14155550101", "ZELNUM_IDEMPOTENCY_KEY": "docs-key", "ZELNUM_BULK_PRODUCT": "phone-bulk"}.items():
        monkeypatch.setenv(key, value)
    (tmp_path / "identifiers.txt").write_text("+14155550101\n")
    with respx.mock:
        respx.get(BASE + "/products").respond(200, json={"data": [{"id": 47, "slug": "phone-rt", "mode": "realtime", "series": "phone"}]})
        respx.post(BASE + "/realtime/quote/phone").respond(200, json=QUOTE)
        respx.post(BASE + "/realtime/check/phone").respond(200, json={"results": []})
        respx.post(BASE + "/quotes/bulk").respond(200, json=QUOTE)
        respx.post(BASE + "/detect").respond(202, json={"task_id": "t1"})
        for snippet in re.findall(r"```python\n(.*?)```", (ROOT / "README.md").read_text(), flags=re.S):
            exec(compile(snippet, "README.md", "exec"), {})

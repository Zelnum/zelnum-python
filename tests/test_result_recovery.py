"""Regressions for terminal result errors and failed bulk downloads."""

from __future__ import annotations

import runpy
from pathlib import Path

import httpx
import pytest
import respx

from zelnum import (
    ResultExpiredError,
    ResultNotReadyError,
    ResultUnavailableError,
    ValidationError,
    Zelnum,
    ZelnumError,
)

BASE = "https://api.zelnum.com/api/v1"
ROOT = Path(__file__).resolve().parents[1]


@pytest.mark.parametrize("body,expected", [
    ({"message": "Task is not yet completed."}, ResultNotReadyError),
    ({"message": "Result file has not been generated."}, ResultNotReadyError),
    ({"message": "Result file has expired."}, ResultExpiredError),
    ({"message": "Result file is missing or unavailable."}, ResultUnavailableError),
    ({"message": "An unknown error."}, ResultUnavailableError),
    ({}, ResultUnavailableError),
    ({"code": "result_not_ready", "message": "Task is not complete"}, ResultNotReadyError),
    ({"code": "result_expired", "message": "Localized message"}, ResultExpiredError),
    ({"code": "result_unavailable", "message": "Task is not yet completed."}, ResultUnavailableError),
])
@respx.mock
def test_result_error_classification_and_details(body, expected):
    route = respx.get(BASE + "/tasks/t1/result").respond(
        422, json=body, headers={"Retry-After": "3"},
    )
    with Zelnum("zn_test") as client, pytest.raises(expected) as error:
        client.get_task_result("t1")
    assert type(error.value) is expected
    assert error.value.status == 422
    assert error.value.body == body
    assert error.value.code == body.get("code")
    if body.get("message"):
        assert error.value.message == body["message"]
    assert error.value.retry_after == "3"
    assert route.call_count == 1  # No implicit retry or extra API request.


def test_terminal_results_do_not_inherit_pending_error():
    assert issubclass(ResultExpiredError, ResultUnavailableError)
    assert issubclass(ResultUnavailableError, ZelnumError)
    assert not issubclass(ResultExpiredError, ResultNotReadyError)
    assert not issubclass(ResultUnavailableError, ResultNotReadyError)


@respx.mock
def test_other_endpoints_keep_normal_422_classification():
    respx.post(BASE + "/detect").respond(422, json={"message": "Result file has expired."})
    with Zelnum("zn_test") as client, pytest.raises(ValidationError):
        client.create_bulk_task("email-product", ["user@example.com"])


@pytest.fixture
def bulk_run(monkeypatch, tmp_path):
    monkeypatch.setenv("ZELNUM_API_KEY", "zn_test")
    source = tmp_path / "identifiers.txt"
    source.write_text("user@example.com\n", encoding="utf-8")
    output = tmp_path / "result.zip"
    main = runpy.run_path(str(ROOT / "examples/bulk.py"))["main"]
    args = [str(source), "--product", "email-product", "--execute",
            "--idempotency-key", "saved-key", "--output", str(output)]
    with respx.mock as router:
        router.get(BASE + "/products").respond(200, json={"data": [
            {"slug": "email-product", "mode": "async", "series": "email", "min_phones": 1},
        ]})
        router.post(BASE + "/quotes/bulk").respond(200, json={
            "quote": {"quote_token": "qt_test", "total": 1},
        })
        submit = router.post(BASE + "/detect").respond(202, json={"task_id": "t1"})
        router.get(BASE + "/tasks/t1").respond(200, json={
            "status": "completed", "result_available": True,
        })
        download = router.get(BASE + "/tasks/t1/download")
        yield main, args, output, submit, download


@pytest.mark.parametrize("failure", ["timeout", "interrupted", 404, 500])
def test_download_failure_leaves_no_file_and_allows_recovery(bulk_run, failure, capsys):
    main, args, output, submit, download = bulk_run
    if failure == "timeout":
        download.mock(side_effect=httpx.ReadTimeout("Simulated timeout"))
    elif failure == "interrupted":
        download.mock(side_effect=httpx.RemoteProtocolError("Incomplete response"))
    else:
        download.respond(failure, json={"message": "Result unavailable"})
    assert main(args) == 1
    assert not output.exists()
    assert "Saved " not in capsys.readouterr().out

    download.respond(200, content=b"ZIP-DATA")
    assert main(args) == 0
    assert output.read_bytes() == b"ZIP-DATA"
    assert submit.call_count == 2
    assert all(c.request.headers["Idempotency-Key"] == "saved-key" for c in submit.calls)


def test_existing_output_is_unchanged(bulk_run):
    main, args, output, submit, download = bulk_run
    output.write_bytes(b"existing-user-file")
    assert main(args) == 1
    assert output.read_bytes() == b"existing-user-file"
    assert not submit.called
    assert not download.called


def test_file_created_during_download_is_not_overwritten(bulk_run):
    main, args, output, submit, download = bulk_run
    def competing_writer(request):
        output.write_bytes(b"created-by-another-process")
        return httpx.Response(200, content=b"ZIP-DATA")
    download.mock(side_effect=competing_writer)
    assert main(args) == 1
    assert output.read_bytes() == b"created-by-another-process"

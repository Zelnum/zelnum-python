# Zelnum — Official Python SDK

[![Website](https://img.shields.io/badge/website-zelnum.com-blue)](https://zelnum.com)
[![PyPI version](https://img.shields.io/pypi/v/zelnum.svg)](https://pypi.org/project/zelnum/)

The Python client for [Zelnum](https://zelnum.com), a phone number and email
verification platform. Check registration on supported services using realtime
checks or asynchronous bulk tasks. These checks do not, by themselves, prove
identity, consent to contact, or email deliverability.

To use this SDK, you need a Zelnum API key. Create an account at
[zelnum.com](https://zelnum.com), then read the full API reference at
[docs.zelnum.com](https://docs.zelnum.com).

## Installation and account setup

Requires Python 3.9+.

```bash
python -m pip install zelnum
```

1. Create an account or sign in at [zelnum.com](https://zelnum.com).
2. Open **API Center**, create an API key, and copy it when shown. Keep the secret
   outside source code and logs. See [authentication](https://docs.zelnum.com/authentication/).
3. Configure the environment variable below. Billable checks need sufficient
   account balance; see [Zelnum pricing](https://zelnum.com/pricing/).
4. List the current products and select the right mode and series. Product IDs,
   availability, prices, and minimum batch sizes can change.

```bash
export ZELNUM_API_KEY="YOUR_API_KEY"
zelnum products
zelnum balance
```

In PowerShell use `$env:ZELNUM_API_KEY="YOUR_API_KEY"`.
`zelnum products` also works without an API key. Never publish your real key.

```python
import os
from zelnum import Zelnum

with Zelnum(os.environ["ZELNUM_API_KEY"]) as client:
    for product in client.list_products()["data"]:
        print(product["id"], product["slug"], product["mode"],
              product["series"], product.get("min_phones"))
```

## Supported modes

| Mode | Phone and email support | Product selector | Operations |
| --- | --- | --- | --- |
| Realtime | Both, through `series="phone"` or `"email"` | 1–10 unique numeric IDs with `mode="realtime"` and matching series | Quote and check one identifier |
| Bulk | Both; series is determined by the product | One slug with `mode="async"` | Quote, submit a list or file, poll, get result metadata, download |

For phone bulk tasks, supply an ISO two-letter `country`, for example `US`.
For email products, omit `country`. The API field `phones` also holds email
addresses when an email product is selected. Respect the product's `min_phones`.

## Realtime: quote, then execute

Choose a realtime product ID from the catalogue and set `ZELNUM_PRODUCT_ID`.
Use a phone number you are authorized to check for `ZELNUM_IDENTIFIER`.
Set `ZELNUM_IDEMPOTENCY_KEY` to a unique identifier for this logical request,
and save it before sending. The following example **executes a billable check**.

```python
import os
from zelnum import Zelnum

with Zelnum(os.environ["ZELNUM_API_KEY"]) as client:
    identifier = os.environ["ZELNUM_IDENTIFIER"]
    product_ids = [int(os.environ["ZELNUM_PRODUCT_ID"])]
    quote = client.quote_realtime(identifier, product_ids, country="US")["quote"]
    print("Quoted total:", quote["total"], quote["currency"])
    result = client.check_realtime(
        identifier, product_ids, country="US",
        idempotency_key=os.environ["ZELNUM_IDEMPOTENCY_KEY"],
        quote_token=quote["quote_token"], quoted_total=quote["total"],
    )
    print(result)
```

For email, use an email realtime product and email identifier, pass
`series="email"` to **both** methods, and omit `country`.
Quote responses have an outer `{"quote": {...}}` object. Quotes expire;
the quote and execution must use matching input. Pass both quote fields together.

In a repository checkout, the [quickstart example](https://github.com/Zelnum/zelnum-python/blob/main/examples/quickstart.py)
validates the chosen products and only quotes unless `--execute` is supplied:

```bash
python examples/quickstart.py "$ZELNUM_IDENTIFIER" --products "$ZELNUM_PRODUCT_ID" --country US
# This second command is billable:
python examples/quickstart.py "$ZELNUM_IDENTIFIER" --products "$ZELNUM_PRODUCT_ID" --country US --execute --idempotency-key "$ZELNUM_IDEMPOTENCY_KEY"
```

## Bulk: lists, files, polling and downloads

Prepare a UTF-8 text file with one real identifier per line (no header), meeting
the selected product's minimum. Set `ZELNUM_BULK_PRODUCT` to its async slug.
The [bulk example](https://github.com/Zelnum/zelnum-python/blob/main/examples/bulk.py)
supports phone and email lists, validates the product, and quotes first:

```bash
python examples/bulk.py identifiers.txt --product "$ZELNUM_BULK_PRODUCT" --country US
# Billable submission; polls for up to 5 minutes and downloads the result:
python examples/bulk.py identifiers.txt --product "$ZELNUM_BULK_PRODUCT" --country US --execute --idempotency-key "$ZELNUM_IDEMPOTENCY_KEY" --output result.zip
```

For email lists, select an email async product and omit `--country`.
A polling timeout does **not** cancel the task: save the printed task ID and
resume with `zelnum task TASK_ID`, then `zelnum download TASK_ID -o result.zip`.
Do not submit a new task just because waiting stopped.

The equivalent SDK calls are:

```python
import os
from pathlib import Path
from zelnum import Zelnum

identifiers = [s.strip() for s in Path("identifiers.txt").read_text(encoding="utf-8-sig").splitlines() if s.strip()]
product = os.environ["ZELNUM_BULK_PRODUCT"]
with Zelnum(os.environ["ZELNUM_API_KEY"]) as client:
    quote = client.quote_bulk(product, identifiers, country="US")["quote"]
    task = client.create_bulk_task(
        product, identifiers, country="US",
        idempotency_key=os.environ["ZELNUM_IDEMPOTENCY_KEY"],
        quote_token=quote["quote_token"], quoted_total=quote["total"],
    )
    print(task["task_id"])
```

Bulk **quotes** accept at most 10,000 identifiers; this is not the general
submission limit. For larger lists use `create_bulk_task_from_file(product,
"identifiers.txt", country="US", idempotency_key=saved_key)` with values you
selected above. Uploads are billable, subject to current file/product limits,
and do not support the quote-token parameters. Check the
[API reference](https://docs.zelnum.com) before large submissions.
`get_task_status(task_id)` reports progress; `get_task_result(task_id)` returns
result metadata, not the result rows. `download_task_result(task_id)` returns
bytes and holds the entire download in memory.

## Retry safety and error handling

The SDK generates a new UUID when you omit `idempotency_key` on a realtime,
bulk-list or bulk-file submission. **A new method call gets a new key.** To retry
after a timeout without accidentally creating another charge/task, reuse the
saved key and identical input, within the server's idempotency retention window.
Use a different key for a different logical request. The SDK does not retry
automatically. Check task/request state before retrying an ambiguous failure.

API/network failures inherit `ZelnumError`. Invalid local arguments raise
`ValueError`; local file failures raise `OSError`.

| Exception | Meaning |
| --- | --- |
| `AuthenticationError` | HTTP 401: invalid or revoked key |
| `InsufficientBalanceError` | HTTP 402: insufficient balance |
| `ValidationError` | HTTP 400/422: invalid input; inspect `errors` |
| `NotFoundError` | HTTP 404: missing resource |
| `ConflictError` | HTTP 409: conflict; inspect `code` before retrying |
| `RateLimitError` | HTTP 429: respect `retry_after` if supplied (seconds or HTTP date) |
| `ResultNotReadyError` | Known pending-result response: check task status and poll only if still running |
| `ResultExpiredError` | Result file expired: polling cannot restore it |
| `ResultUnavailableError` | Result missing/unavailable or an unrecognized result-metadata 422: inspect the failure before retrying |
| `ServerError` | HTTP 5xx: service failure; preserve your submission key |
| `NetworkError` | Timeout or connection failure; execution may already have occurred |
| `ProtocolError` | Unexpected redirect or malformed JSON response |

Read [API error codes](https://docs.zelnum.com/errors/) for recovery guidance.
`ResultExpiredError` inherits from `ResultUnavailableError`, not from
`ResultNotReadyError`. The current API returns message-only result errors;
the SDK recognizes known messages and treats unknown ones as unavailable.
The bulk example downloads the complete response before creating the output
file, so network/API failures do not leave an empty file or overwrite one.
Use the client as a context manager. If you pass `http_client=httpx.Client(...)`,
you own that client's lifecycle; the SDK still applies its API URL, key and timeout.

## CLI

`zelnum --help` lists commands. The CLI supports realtime quoting/checking and
bulk status/download; submit bulk tasks through the Python SDK or bulk example.
For realtime retries, use `zelnum check ... --idempotency-key YOUR_SAVED_KEY`.
`zelnum api-key` retrieves masked metadata, not your secret key.

## Resources

- [Zelnum official website](https://zelnum.com)
- [Create an account](https://zelnum.com)
- [API documentation](https://docs.zelnum.com)
- [Pricing](https://zelnum.com/pricing/)
- [Report an SDK issue](https://github.com/Zelnum/zelnum-python/issues)

## License

MIT — see [LICENSE](https://github.com/Zelnum/zelnum-python/blob/main/LICENSE).

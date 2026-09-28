"""Quote and optionally submit a list, poll with a deadline, and download results.

Website and sign-up: https://zelnum.com
API reference: https://docs.zelnum.com
This JSON-quote example supports up to 10,000 identifiers; see README for uploads.
"""

from __future__ import annotations

import argparse
import json
import os
import time
from pathlib import Path

from zelnum import Zelnum, ZelnumError


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("file", help="UTF-8 text, one phone number or email per line")
    parser.add_argument("--product", required=True, help="An async product slug from zelnum products")
    parser.add_argument("--country", help="Required for phone products; omit for email")
    parser.add_argument("--execute", action="store_true", help="Submit a billable task")
    parser.add_argument("--idempotency-key", help="Persist and reuse for identical retries")
    parser.add_argument("--wait-seconds", type=float, default=300)
    parser.add_argument("--output", default="result.zip", help="Must not already exist")
    args = parser.parse_args(argv)
    api_key = os.environ.get("ZELNUM_API_KEY")
    if not api_key:
        parser.error("Set ZELNUM_API_KEY; get a key at https://zelnum.com")
    if args.execute and not args.idempotency_key:
        parser.error("--execute requires a persistent --idempotency-key")
    if args.wait_seconds <= 0:
        parser.error("--wait-seconds must be positive")
    try:
        if args.execute and Path(args.output).exists():
            raise ValueError("Output already exists; choose another --output")
        identifiers = [line.strip() for line in Path(args.file).read_text(encoding="utf-8-sig").splitlines() if line.strip()]
        with Zelnum(api_key) as client:
            product = next((p for p in client.list_products()["data"] if p["slug"] == args.product), None)
            if not product or product["mode"] != "async":
                raise ValueError("Choose an async product slug from zelnum products")
            if product["series"] == "phone" and not args.country:
                raise ValueError("Phone bulk products require --country")
            if product["series"] == "email" and args.country:
                raise ValueError("Email bulk products must omit --country")
            minimum = product.get("min_phones") or 1
            if len(identifiers) < minimum:
                raise ValueError(f"This product requires at least {minimum} identifiers")
            quote = client.quote_bulk(args.product, identifiers, country=args.country)["quote"]
            print(json.dumps(quote, indent=2))
            if not args.execute:
                return 0
            task = client.create_bulk_task(
                args.product, identifiers, country=args.country,
                idempotency_key=args.idempotency_key,
                quote_token=quote["quote_token"], quoted_total=quote["total"],
            )
            task_id = task["task_id"]
            print(f"Task submitted: {task_id}", flush=True)
            deadline = time.monotonic() + args.wait_seconds
            while time.monotonic() < deadline:
                status = client.get_task_status(task_id)
                if status["status"] == "failed":
                    raise ValueError(f"Task {task_id} failed; inspect it in the Console")
                if status.get("result_available"):
                    # A failed download must not leave an empty output file.
                    # Keep exclusive creation so an existing file is never overwritten.
                    content = client.download_task_result(task_id)
                    with open(args.output, "xb") as output:
                        output.write(content)
                    print(f"Saved {args.output}")
                    return 0
                time.sleep(min(4, max(0, deadline - time.monotonic())))
            print(f"Stopped waiting; task {task_id} is NOT cancelled. Resume with: zelnum task {task_id}")
            return 2
    except (ZelnumError, ValueError, OSError) as exc:
        print(f"Error: {exc}")
        return 1


if __name__ == "__main__":
    raise SystemExit(main())

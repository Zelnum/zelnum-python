"""Quote first; add --execute and a persistent --idempotency-key to run a check.

Website and sign-up: https://zelnum.com
API reference: https://docs.zelnum.com
"""

from __future__ import annotations

import argparse
import json
import os

from zelnum import Zelnum, ZelnumError


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("identifier")
    parser.add_argument("--products", required=True, help="Real product IDs from zelnum products")
    parser.add_argument("--series", choices=["phone", "email"], default="phone")
    parser.add_argument("--country")
    parser.add_argument("--execute", action="store_true", help="Execute a billable check")
    parser.add_argument("--idempotency-key", help="Persist and reuse for identical retries")
    args = parser.parse_args(argv)
    api_key = os.environ.get("ZELNUM_API_KEY")
    if not api_key:
        parser.error("Set ZELNUM_API_KEY; get a key at https://zelnum.com")
    if args.execute and not args.idempotency_key:
        parser.error("--execute requires a persistent --idempotency-key")
    if args.series == "email" and args.country:
        parser.error("Email products must omit --country")
    try:
        product_ids = [int(value) for value in args.products.split(",")]
        with Zelnum(api_key) as client:
            catalog = {p["id"]: p for p in client.list_products()["data"]}
            for product_id in product_ids:
                product = catalog.get(product_id)
                if not product or product["mode"] != "realtime" or product["series"] != args.series:
                    raise ValueError(f"Product {product_id} is not a {args.series} realtime product")
            quote = client.quote_realtime(
                args.identifier, product_ids, series=args.series, country=args.country,
            )["quote"]
            print(json.dumps(quote, indent=2))
            if args.execute:
                result = client.check_realtime(
                    args.identifier, product_ids, series=args.series, country=args.country,
                    idempotency_key=args.idempotency_key,
                    quote_token=quote["quote_token"], quoted_total=quote["total"],
                )
                print(json.dumps(result, indent=2))
        return 0
    except (ZelnumError, ValueError, OSError) as exc:
        print(f"Error: {exc}")
        return 1


if __name__ == "__main__":
    raise SystemExit(main())

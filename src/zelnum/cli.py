"""Command line interface for the Zelnum SDK.

Usage examples::

    zelnum balance
    zelnum products
    zelnum check +14155550101 --products 101,102 --country US
    zelnum check user@example.com --series email --products 201
    zelnum task <task_id>
    zelnum download <task_id> -o result.zip

The API key is read from the ``ZELNUM_API_KEY`` environment variable or the
``--api-key`` flag. Get a key at https://zelnum.com.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from typing import Any, Optional

from .client import Zelnum
from .exceptions import ZelnumError


def _get_version() -> str:
    from . import __version__

    return __version__


def _parse_product_ids(raw: str) -> list[int]:
    try:
        return [int(part.strip()) for part in raw.split(",") if part.strip()]
    except ValueError as exc:
        raise ValueError(f"Invalid --products value: {raw!r} (expected comma-separated ints)") from exc


def _print(data: Any) -> None:
    print(json.dumps(data, indent=2, ensure_ascii=False))


def build_parser() -> argparse.ArgumentParser:
    # Shared flags use SUPPRESS defaults so they can be given either before
    # or after the subcommand without the subparser clobbering the value.
    common = argparse.ArgumentParser(add_help=False)
    common.add_argument(
        "--api-key", default=argparse.SUPPRESS,
        help="API key (defaults to $ZELNUM_API_KEY)",
    )
    common.add_argument(
        "--base-url", default=argparse.SUPPRESS, help="Override API base URL"
    )

    parser = argparse.ArgumentParser(
        prog="zelnum",
        description=(
            "Zelnum phone & email verification CLI — https://zelnum.com "
            "(API reference: https://docs.zelnum.com)"
        ),
        parents=[common],
    )
    parser.add_argument(
        "--version", action="version", version=f"%(prog)s {_get_version()}"
    )
    sub = parser.add_subparsers(dest="command", required=True)

    sub.add_parser("balance", help="Show account balance", parents=[common])
    sub.add_parser("products", help="List active products", parents=[common])
    sub.add_parser("api-key", help="Show API key metadata", parents=[common])

    check = sub.add_parser(
        "check", help="Realtime check one identifier", parents=[common]
    )
    check.add_argument("identifier")
    check.add_argument("--products", required=True, help="Comma-separated product IDs (1-10)")
    check.add_argument("--series", default="phone", choices=["phone", "email"])
    check.add_argument("--country", default=None, help="ISO country code (optional)")
    check.add_argument("--idempotency-key", help="Reuse this key and identical input when retrying")

    quote = sub.add_parser(
        "quote", help="Quote a realtime check without charging", parents=[common]
    )
    quote.add_argument("identifier")
    quote.add_argument("--products", required=True)
    quote.add_argument("--series", default="phone", choices=["phone", "email"])
    quote.add_argument("--country", default=None)

    task = sub.add_parser("task", help="Show bulk task status", parents=[common])
    task.add_argument("task_id")

    download = sub.add_parser(
        "download", help="Download a finished bulk task result", parents=[common]
    )
    download.add_argument("task_id")
    download.add_argument("-o", "--output", required=True, help="Output file path")

    return parser


def main(argv: Optional[list[str]] = None) -> int:
    args = build_parser().parse_args(argv)

    api_key = getattr(args, "api_key", None) or os.environ.get("ZELNUM_API_KEY")
    if not api_key:
        if args.command == "products":
            # GET /products is a public endpoint; allow browsing before signup.
            api_key = "public"
        else:
            print(
                "No API key. Set ZELNUM_API_KEY or pass --api-key. "
                "Get a key at https://zelnum.com",
                file=sys.stderr,
            )
            return 2

    kwargs: dict[str, Any] = {}
    if getattr(args, "base_url", None):
        kwargs["base_url"] = args.base_url

    try:
        with Zelnum(api_key, **kwargs) as client:
            if args.command == "balance":
                _print(client.get_balance())
            elif args.command == "products":
                _print(client.list_products())
            elif args.command == "api-key":
                _print(client.get_api_key())
            elif args.command == "check":
                result = client.check_realtime(
                    args.identifier,
                    _parse_product_ids(args.products),
                    series=args.series,
                    country=args.country,
                    idempotency_key=args.idempotency_key,
                )
                _print(result)
            elif args.command == "quote":
                result = client.quote_realtime(
                    args.identifier,
                    _parse_product_ids(args.products),
                    series=args.series,
                    country=args.country,
                )
                _print(result)
            elif args.command == "task":
                _print(client.get_task_status(args.task_id))
            elif args.command == "download":
                content = client.download_task_result(args.task_id)
                with open(args.output, "wb") as fh:
                    fh.write(content)
                print(f"Saved {len(content)} bytes to {args.output}")
        return 0
    except ZelnumError as exc:
        print(f"Error: {exc}", file=sys.stderr)
        return 1
    except (ValueError, OSError) as exc:
        print(f"Error: {exc}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    sys.exit(main())

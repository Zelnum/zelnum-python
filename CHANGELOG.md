# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.1] - 2026-09-28

### Changed

- Install section: dropped the pre-release note that told users to install from
  a repository checkout. `python -m pip install zelnum` is the supported path
  now that the package is published on PyPI.

## [0.1.0] - 2026-09-28

### Added

- Bulk submission idempotency keys and quote headers for JSON submissions
- Quote-first phone/email examples with bounded bulk polling
- Regression tests and release artifact/link validation

### Fixed

- Expired/missing result responses no longer raise `ResultNotReadyError`;
  exported `ResultExpiredError` and `ResultUnavailableError` preserve the distinction
- Bulk example waits for a successful download before creating the output file
- Nested quote response examples, unsafe retry claims and account setup instructions
- HTTP 422 validation errors, custom HTTP client authentication/URL/ownership
- CLI input/file error handling and explicit realtime idempotency keys
- Tag-triggered publishing; publish only tested and validated artifacts
- Malformed JSON/redirect responses now raise `ProtocolError`

### Initial functionality

- `Zelnum` client: `list_products`, `get_balance`, `get_api_key`
- Realtime: `check_realtime` (auto `Idempotency-Key`), `quote_realtime`
- Bulk: `create_bulk_task`, `create_bulk_task_from_file`, `quote_bulk`,
  `get_task_status`, `get_task_result`, `download_task_result`
- Typed exceptions per HTTP status (`ZelnumError` base)
- `zelnum` CLI (`balance`, `products`, `check`, `quote`, `task`, `download`)
- PyPI Trusted Publishing workflow

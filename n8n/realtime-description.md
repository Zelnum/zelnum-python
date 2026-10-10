## Who is this for?

Verify a phone number or email lead before updating a CRM or starting an outreach workflow. Built for operations teams and developers, this template uses Zelnum's realtime API through n8n's built-in HTTP Request nodes.

## What it does

Loads the current product catalog, validates your products, and requests a non-billable quote. Checks require explicit billing approval and a USDT spending limit. Output preserves each product's `valid`, `invalid`, or `unknown` verdict, billing status, and error code. Inconclusive answers require manual review; they are not treated as invalid.

## How to set up

1. [Register with Zelnum](https://app.zelnum.com), open API Center, and create an API key.
2. Create a Header Auth credential: name `X-API-Key`, value your private key. Select it on both authenticated HTTP Request nodes.
3. Configure your identifier, series, current product IDs, and request key. Run with `execute_billable=false` to inspect pricing.
4. Set your spending limit and enable billing only when ready. Keep the same key and inputs for retries.

## Requirements and customization

Requires a funded Zelnum account for paid checks and compatible built-in n8n nodes. After testing, replace the manual trigger with an authenticated CRM or form trigger. Verdicts describe the selected product, not contact consent or guaranteed email deliverability.

Read the [Zelnum API documentation](https://docs.zelnum.com) for coverage, billing, and errors. Visit [Zelnum](https://zelnum.com) for the platform overview.

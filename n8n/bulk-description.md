## Who is this for?

For operations teams and developers preparing contact lists for a CRM import. Verify phone numbers or email addresses in bulk with Zelnum using n8n's built-in HTTP Request and Wait nodes.

## What it does

Normalizes and deduplicates your list, checks the current product minimum, and requests a non-billable quote. Submission requires explicit billing approval and a USDT spending limit. Bounded polling distinguishes failed or expired results from pending work. Completed ZIP/CSV results download as n8n binary data. Resume an existing task without another paid submission.

## How to set up

1. [Register with Zelnum](https://app.zelnum.com), create an API key in API Center, and fund your account for paid checks.
2. Create Header Auth with name `X-API-Key` and your private key; select it on all five authenticated HTTP Request nodes.
3. Configure the series, product slug, list, and request key. Keep `execute_billable=false` to preview pricing; set a spending limit before enabling submission.
4. Save the returned task ID. Use `resume_task_id` to continue status checks or downloads later.

## Requirements and customization

Requires compatible built-in n8n nodes. Meet the selected product's minimum; this quoted-array template accepts up to 10,000 input contacts. Attach storage after the validated download; no file writer is included.

See the [Zelnum API documentation](https://docs.zelnum.com) for product coverage and result retention, or visit [Zelnum](https://zelnum.com). Product verdicts do not establish contact consent.

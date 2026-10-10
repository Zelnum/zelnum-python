# Zelnum Node-RED flows

Use [Zelnum](https://zelnum.com) phone and email verification in Node-RED:
check a single contact with realtime mode, or submit a list with bulk mode
and download its results. Both examples use built-in Node-RED nodes.

## Create an account and API key

1. Register or sign in at [app.zelnum.com](https://app.zelnum.com).
2. Open **API Center** and create an API key. Keep it private.
3. Read the [API documentation](https://docs.zelnum.com) for product coverage,
   billing, rate limits and error codes.

## Import and configure

1. Copy a flow JSON and choose **Menu → Import → Clipboard** in Node-RED.
2. Double-click the imported flow tab to open **Flow Properties**, then use
   its **Environment Variables** tab (Node-RED 2.1+). Add the values below,
   click **Done**, and **Deploy**. Use String type for identifiers and keys.
   These variables are also accessible through `env.get()` in Function nodes.
   Global variables, when needed, are in **User Settings → Environment**
   (Node-RED 3.1+), not Manage palette.
3. Set your secret API key only in your own Node-RED runtime. Flow variables
   can be included in exports, so remove secret values before sharing a flow.

### Realtime: one phone number or email address

Import `zelnum-realtime-verification.json`. Configure:

| Variable | Value |
| --- | --- |
| `ZELNUM_API_KEY` | Your private API key |
| `ZELNUM_REALTIME_PRODUCT_ID` | Current realtime product ID from `GET https://api.zelnum.com/api/v1/products` |
| `ZELNUM_SERIES` | `phone` or `email`, matching the selected product |
| `ZELNUM_IDENTIFIER` | The contact you want to verify |
| `ZELNUM_COUNTRY` | ISO country code for phone, e.g. `US`; omitted for email |
| `ZELNUM_IDEMPOTENCY_KEY` | A unique key for this logical realtime request |

Click **1. Get quote (no charge)** and inspect its price in the Debug sidebar.
Then click **2. Execute check (BILLABLE)** only when you want to perform the
check. The response appears in **Realtime result**.

### Bulk: submit, inspect and download

Import `zelnum-bulk-verification.json`. Configure:

| Variable | Value |
| --- | --- |
| `ZELNUM_API_KEY` | Your private API key |
| `ZELNUM_BULK_PRODUCT` | Current async product slug, from **Get products** |
| `ZELNUM_BULK_SERIES` | `phone` or `email`, matching that product |
| `ZELNUM_IDENTIFIERS` | Your own comma-separated or newline-separated list |
| `ZELNUM_COUNTRY` | ISO country code for phone; omitted for email |
| `ZELNUM_IDEMPOTENCY_KEY` | A unique key for this logical bulk submission |
| `ZELNUM_TASK_ID` | Optional existing task ID for status/download after a restart; leave blank for a newly submitted task |

1. Click **1. Get products / minimum rows**. Review `slug`, `series` and
   `min_phones` in **Product minimums**. Select a current async product.
2. Supply a real list meeting that product's minimum. Two example numbers
   are not a valid production batch. Do not pad a batch with dummy or repeated
   values. This array-quote example accepts at most **10,000 rows**;
   use split batches or consult the file submission API for larger inputs.
3. Deploy your variables and click **2. Quote list (no charge)**. Product
   metadata is refreshed manually and accepted for five minutes; click Get
   products again if prompted. Review the quoted cost.
4. Click **3. Submit task (BILLABLE)**. The flow remembers the returned task
   ID. If `ZELNUM_TASK_ID` is set, status/download use that value instead.
5. Click **4. Get task status**. Repeat manually at 3–5 second intervals
   while pending/processing. Failed tasks are reported separately.
6. Click **5. Get result and download** when results are available. This
   fetches result metadata, then the authenticated ZIP/CSV download. The
   result reaches **Downloaded result Buffer** as `msg.payload`; the suggested
   name is `msg.filename`, with byte count in `msg.zelnumDownload`.

The example downloads into memory and does not write local files. You can
connect a File node **after Reject failed / empty download** to save a valid
buffer, using a path appropriate to your deployment. Failed or empty downloads
never reach that output. For large files, prefer a streaming download client.
Result URLs require the API key; opening the URL alone in a browser is not enough.

## Quotes, retries and errors

- Quotes expire at their returned `expires_at`. Get a new quote if expired.
- Changing the identifier/list, product, series or country requires a new
  quote. Execution is blocked if those inputs differ from the reviewed quote.
- Keep the same idempotency key when retrying the same logical request. Use
  a new key for each new request, and separate keys for realtime and bulk.
- A completed task with no available result is completed but unavailable or
  expired, not still processing. `404` on result/download is distinct from
  `422 result_not_ready`. Download before the returned expiry time.
- The example checks HTTP responses and routes failures to **Zelnum error**.
  See [error codes](https://docs.zelnum.com/errors/) and
  [bulk result documentation](https://docs.zelnum.com/async-detection/result/).

No API key or contact list is shipped in these examples. Only the separately
labelled BILLABLE inject nodes perform chargeable checks/submissions.

Website: [zelnum.com](https://zelnum.com) ·
Sign up: [app.zelnum.com](https://app.zelnum.com) ·
API docs: [docs.zelnum.com](https://docs.zelnum.com) ·
Python SDK: [Zelnum/zelnum-python](https://github.com/Zelnum/zelnum-python)

'use strict';

// These functions become dependency-free n8n Code node bodies. No API keys here.
function emit(json) { return [{ json, pairedItem: { item: 0 } }]; }
function responseBody(response, label, accepted = [200]) {
  const status = Number(response.statusCode);
  if (!Number.isInteger(status) || !accepted.includes(status)) {
    const code = typeof response.body?.code === 'string' ? response.body.code : 'unexpected_response';
    const hint = status === 404 ? ' Missing, expired, or inaccessible result/task.'
      : status === 422 ? ' Check validation or result_not_ready; do not call this expired.'
      : [409, 429, 500, 503].includes(status) ? ' Retry later with the SAME inputs and idempotency key; do not create a new paid request.' : '';
    throw new Error(`${label}: HTTP ${status || 'unknown'} (${code}).${hint} See https://docs.zelnum.com/errors/`);
  }
  if (!response.body || typeof response.body !== 'object' || Array.isArray(response.body)) throw new Error(`${label}: malformed JSON response.`);
  return response.body;
}
function text(value) { return String(value ?? '').trim(); }
function seriesAndCountry(config, bulk) {
  const series = text(config.series).toLowerCase();
  if (!['phone', 'email'].includes(series)) throw new Error('series must be phone or email.');
  const country = series === 'phone' ? text(config.country).toUpperCase() : '';
  if ((bulk && series === 'phone' && !country) || (country && !/^[A-Z]{2}$/.test(country))) throw new Error('Phone country must be a two-letter ISO code.');
  return { series, country };
}
function contact(value, series, country) {
  const raw = text(value);
  if (!raw || raw.length > 254) throw new Error('Supply your own non-empty contact, at most 254 characters.');
  if (series === 'email') {
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(raw)) throw new Error('Invalid email format.');
    return raw; // Do not lowercase the local part or invent an address.
  }
  if (!/^\+?[0-9().\s-]+$/.test(raw)) throw new Error('Invalid phone characters.');
  const valueClean = raw.replace(/[().\s-]/g, '');
  if (!/^\+?[0-9]{4,15}$/.test(valueClean) || (valueClean.startsWith('+') && !/^\+[1-9][0-9]{3,14}$/.test(valueClean))) throw new Error('Invalid phone length or international prefix.');
  if (!valueClean.startsWith('+') && !country) throw new Error('National phone numbers require country.');
  return valueClean;
}
function billingConfig(config) {
  if (typeof config.execute_billable !== 'boolean') throw new Error('execute_billable must be a Boolean, not a string.');
  const max = config.max_total_usdt;
  if (typeof max !== 'number' || !Number.isFinite(max) || max < 0) throw new Error('max_total_usdt must be a non-negative number.');
  const key = text(config.idempotency_key);
  if (key && !/^[A-Za-z0-9._:-]{1,191}$/.test(key)) throw new Error('Use a request key of 1–191 ASCII letters, digits, dots, underscores, colons, or hyphens.');
  if (config.execute_billable && !key) throw new Error('Paid requests require a stable idempotency_key.');
  return { execute_billable: config.execute_billable, max_total_usdt: max, idempotency_key: key };
}
function taskToken(value) {
  const token = text(value);
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(token)) throw new Error('Invalid task_id; copy the task token returned by Zelnum.');
  return token;
}
function checkedQuote(quote) {
  if (!quote || typeof quote.quote_token !== 'string' || !quote.quote_token.trim() || quote.currency !== 'USDT' || !['number', 'string'].includes(typeof quote.total) || String(quote.total).trim() === '' || !Number.isFinite(Number(quote.total)) || Number(quote.total) < 0 || !Number.isFinite(Date.parse(quote.expires_at)) || Date.parse(quote.expires_at) <= Date.now()) throw new Error('Quote is malformed or expired; run again for a fresh quote.');
  return quote;
}
function validateRealtime() {
  const config = $('Configure realtime request').first().json;
  const catalog = responseBody($input.first().json, 'Product catalog');
  if (!Array.isArray(catalog.data)) throw new Error('Product catalog missing data array.');
  const { series, country } = seriesAndCountry(config, false);
  let ids = config.product_ids;
  if (!Array.isArray(ids) || ids.length < 1 || ids.length > 10 || ids.some(id => !Number.isInteger(id) || id < 1) || new Set(ids).size !== ids.length) throw new Error('Choose 1–10 distinct numeric realtime product IDs from https://docs.zelnum.com/realtime-products/');
  if (ids.some(id => !catalog.data.some(p => p.id === id && p.mode === 'realtime' && p.series === series))) throw new Error('Product IDs must exist in the current realtime catalog and match the series.');
  const request = { identifier: contact(config.identifier, series, country), product_ids: [...ids] };
  if (country) request.country = country;
  return emit({ ...billingConfig(config), series, request });
}
function validateBulkSettings() {
  const config = $input.first().json;
  const max = config.max_poll_attempts;
  const interval = config.poll_interval_seconds;
  if (!Number.isInteger(max) || max < 1 || max > 360) throw new Error('max_poll_attempts must be an integer from 1 to 360.');
  if (!Number.isInteger(interval) || interval < 3 || interval > 5) throw new Error('poll_interval_seconds must be 3, 4, or 5.');
  const resume = text(config.resume_task_id);
  if (resume) return emit({ resume: true, task_id: taskToken(resume), poll_attempt: 0, max_poll_attempts: max, poll_interval_seconds: interval });
  // Only the read-only resume route can skip contact/billing validation.
  const { series, country } = seriesAndCountry(config, true);
  const product = text(config.product);
  if (!product || product.length > 50) throw new Error('Choose a current async product slug: https://docs.zelnum.com/async-detection/products/');
  if (typeof config.deduplicate !== 'boolean') throw new Error('deduplicate must be a Boolean.');
  const input = typeof config.identifiers === 'string' ? config.identifiers.split(/[,\r\n]+/).map(text).filter(Boolean) : config.identifiers;
  if (!Array.isArray(input) || input.length === 0 || input.length > 10000 || input.some(v => typeof v !== 'string')) throw new Error('Supply 1–10,000 contacts, as a comma/newline-separated string or string array. Split larger lists.');
  const normalized = input.map(value => contact(value, series, country));
  const phones = config.deduplicate ? [...new Set(normalized)] : normalized;
  const request = { product, phones };
  if (country) request.country = country;
  return emit({ ...billingConfig(config), resume: false, series, request, input_count: input.length, submitted_count: phones.length, duplicates_removed: input.length - phones.length, poll_attempt: 0, max_poll_attempts: max, poll_interval_seconds: interval });
}
function validateBulkCatalog() {
  const state = $('Validate bulk settings').first().json;
  const catalog = responseBody($input.first().json, 'Product catalog');
  if (!Array.isArray(catalog.data)) throw new Error('Product catalog missing data array.');
  const product = catalog.data.find(p => p.slug === state.request.product && p.mode === 'async' && p.series === state.series);
  if (!product) throw new Error('Choose an async product from the current catalog matching your series.');
  const minimum = Number(product.min_phones);
  if (!Number.isInteger(minimum) || minimum < 1) throw new Error('Product catalog does not supply a valid minimum; do not guess it.');
  if (state.request.phones.length < minimum) throw new Error(`This product requires at least ${minimum} rows after optional deduplication. Do not pad with fake contacts.`);
  return emit({ ...state, minimum_rows: minimum });
}
function reviewQuote() {
  const state = $('Validate request and products').first().json;
  const quote = checkedQuote(responseBody($input.first().json, 'Quote').quote);
  return emit({ ...state, quote });
}
function authorizeBillable() {
  const state = $input.first().json;
  billingConfig(state);
  if (state.execute_billable !== true || !state.idempotency_key) throw new Error('Explicit billing approval and a stable request key are required.');
  checkedQuote(state.quote);
  if (Number(state.quote.total) > state.max_total_usdt) throw new Error(`Quoted amount ${state.quote.total} USDT exceeds max_total_usdt. No paid request sent.`);
  // Never reread editable settings here: execute the exact snapshotted quote body.
  return emit(state);
}
function quotePreview() {
  const state = $input.first().json;
  return emit({ status: 'quote_only', series: state.series, input_count: state.input_count ?? 1, submitted_count: state.submitted_count ?? 1, duplicates_removed: state.duplicates_removed ?? 0, quote: { total: state.quote.total, currency: state.quote.currency, expires_at: state.quote.expires_at }, next_step: 'Review pricing. To run paid verification, enable execute_billable and set max_total_usdt. Keep your stable idempotency key for retries.' });
}
function realtimeOutput() {
  const state = $('Authorize quoted request').first().json;
  const body = responseBody($input.first().json, 'Realtime check');
  if (!text(body.request_id) || body.series !== state.series || body.identifier !== state.request.identifier || !['succeeded', 'partial_succeeded', 'failed'].includes(body.status) || !Array.isArray(body.results) || body.results.length !== state.request.product_ids.length) throw new Error('Malformed realtime results; do not treat this as successful verification.');
  const results = body.results;
  if (new Set(results.map(r => r.product_id)).size !== results.length || results.some(r => !state.request.product_ids.includes(r.product_id) || !['valid', 'invalid', 'unknown'].includes(r.result) || !['charged', 'refunded'].includes(r.billing_status))) throw new Error('Unexpected product/verdict/billing fields; inspect the API response.');
  const conclusive = body.status === 'succeeded' && results.every(r => r.billing_status === 'charged' && !r.error_code && r.result !== 'unknown');
  const allValid = conclusive && results.every(r => r.result === 'valid');
  const allInvalid = conclusive && results.every(r => r.result === 'invalid');
  return emit({ request_id: body.request_id, identifier: state.request.identifier, series: state.series, status: body.status, verification_state: !conclusive ? 'manual_review' : allValid ? 'all_valid' : allInvalid ? 'all_invalid' : 'mixed_verdicts', all_selected_products_valid: allValid, replayed: body.replayed === true, charged_amount: body.charged_amount, refunded_amount: body.refunded_amount, results, interpretation: 'Verdicts apply only to the selected products. They do not establish outreach consent or universal email deliverability.' });
}
function initializeTask() {
  const state = $('Authorize quoted request').first().json;
  const body = responseBody($input.first().json, 'Bulk submission', [202]);
  const task_id = taskToken(body.task_id);
  return emit({ task_id, poll_attempt: 0, max_poll_attempts: state.max_poll_attempts, poll_interval_seconds: state.poll_interval_seconds, submitted_count: state.submitted_count, duplicates_removed: state.duplicates_removed, idempotent_replay: body.idempotent_replay === true });
}
function preparePoll() {
  const state = $input.first().json;
  const task_id = taskToken(state.task_id);
  if (!Number.isInteger(state.poll_attempt) || state.poll_attempt >= state.max_poll_attempts) throw new Error(`Polling limit reached. Resume ${task_id} later; do not submit another batch.`);
  return emit({ ...state, task_id, poll_attempt: state.poll_attempt + 1, poll_url: `https://api.zelnum.com/api/v1/tasks/${encodeURIComponent(task_id)}` });
}
function assessTask() {
  const state = $('Prepare status request').item.json;
  const body = responseBody($input.first().json, 'Task status');
  if (body.task_id !== state.task_id || !['pending', 'processing', 'completed', 'failed'].includes(body.status)) throw new Error('Invalid task status response.');
  let workflow_status;
  if (body.status === 'failed') workflow_status = 'task_failed';
  else if (body.status === 'completed') {
    if (body.result_expires_at && !Number.isFinite(Date.parse(body.result_expires_at))) throw new Error('Invalid result expiry timestamp.');
    const expired = body.result_expires_at && Date.parse(body.result_expires_at) <= Date.now();
    workflow_status = expired ? 'completed_result_expired' : body.result_available === true ? 'ready_to_download' : 'completed_result_unavailable';
  } else workflow_status = state.poll_attempt >= state.max_poll_attempts ? 'poll_limit_reached' : 'poll_again';
  return emit({ ...state, workflow_status, task_status: body.status, progress: body.progress, failure_message: body.failure_message ?? null, result_expires_at: body.result_expires_at ?? null, counts: { total: body.total, processed: body.processed, valid: body.valid, invalid: body.invalid, unknown: body.unknown } });
}
function terminalStatus() {
  const state = $input.first().json;
  return emit({ task_id: state.task_id, status: state.workflow_status, task_status: state.task_status, poll_attempts: state.poll_attempt, progress: state.progress, failure_message: state.failure_message, result_expires_at: state.result_expires_at, counts: state.counts, next_step: state.workflow_status === 'poll_limit_reached' ? 'Save task_id and set resume_task_id later; this does not submit or charge another batch.' : 'Check the task and result retention in https://docs.zelnum.com/async-detection/result/ . Completed-but-unavailable results are not still processing.' });
}
function validateDownloadURL() {
  const state = $('Assess task status').item.json;
  const body = responseBody($input.first().json, 'Result metadata');
  if (body.task_id !== state.task_id) throw new Error('Result metadata task ID mismatch.');
  const expected = `https://api.zelnum.com/api/v1/tasks/${encodeURIComponent(state.task_id)}/download`;
  if (body.download_url !== expected) throw new Error('Unexpected download URL. Refusing to send credentials to another host or path.');
  if (body.expires_at != null && (!Number.isFinite(Date.parse(body.expires_at)) || Date.parse(body.expires_at) <= Date.now())) throw new Error('Completed result has expired or an invalid expiry. Do not poll it as pending.');
  return emit({ task_id: state.task_id, download_url: expected, expires_at: body.expires_at ?? null, summary: body.summary ?? {}, poll_attempts: state.poll_attempt });
}
async function validateBinary() {
  const item = $input.first();
  const state = $('Validate result URL and expiry').item.json;
  if (Number(item.json.statusCode) !== 200) throw new Error(`Download failed: HTTP ${item.json.statusCode}. No successful file output.`);
  if (!item.binary?.data) throw new Error('Download response has no binary data.');
  // This helper supports filesystem/S3 binary storage too; do not read base64 directly.
  const bytes = await this.helpers.getBinaryDataBuffer(0, 'data');
  if (!bytes || bytes.length === 0) throw new Error('Empty download rejected. No successful file output.');
  const mime = String(item.binary.data.mimeType ?? '').toLowerCase().split(';')[0].trim();
  const zip = bytes.length >= 22 && bytes[0] === 0x50 && bytes[1] === 0x4b && ((bytes[2] === 3 && bytes[3] === 4) || (bytes[2] === 5 && bytes[3] === 6) || (bytes[2] === 7 && bytes[3] === 8));
  const headers = item.json.headers ?? {};
  const disposition = String(headers['content-disposition'] ?? headers['Content-Disposition'] ?? '');
  const prefix = bytes.subarray(0, 4096).toString('utf8').replace(/^\uFEFF/, '').trimStart();
  const csvLike = !/^[\[{<]/.test(prefix) && /[,;\t]/.test(prefix.split(/\r?\n/)[0]);
  const csv = csvLike && (['text/csv', 'application/csv'].includes(mime) || (['text/plain', 'application/octet-stream'].includes(mime) && /\.csv(?:["';\s]|$)/i.test(disposition)));
  if ((!zip && !csv) || (mime === 'application/zip' && !zip)) throw new Error('Download is not a ZIP/CSV result; refusing to output HTML/JSON error content as a file.');
  const binary = { ...item.binary.data, fileName: `zelnum-${state.task_id}.${zip ? 'zip' : 'csv'}` };
  return [{ json: { ...state, status: 'downloaded', bytes: bytes.length, file_name: binary.fileName, next_step: 'Download the data binary property in n8n, or connect your own storage node here.' }, binary: { data: binary }, pairedItem: { item: 0 } }];
}

const helpers = [emit, responseBody, text, seriesAndCountry, contact, billingConfig, taskToken, checkedQuote];
const functions = { validateRealtime, validateBulkSettings, validateBulkCatalog, reviewQuote, authorizeBillable, quotePreview, realtimeOutput, initializeTask, preparePoll, assessTask, terminalStatus, validateDownloadURL, validateBinary };
function code(name) {
  if (!functions[name]) throw new Error(`Unknown Code node function: ${name}`);
  return helpers.map(fn => fn.toString()).join('\n\n') + '\n\n' + functions[name].toString() + `\n\nreturn await ${name}.call(this);`;
}
module.exports = { code };

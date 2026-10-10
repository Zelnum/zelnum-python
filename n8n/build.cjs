'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { code } = require('./src/runtime.cjs');
const titles = {
  realtime: 'Verify phone and email leads with Zelnum via HTTP Request',
  bulk: 'Verify contact lists with Zelnum using HTTP Request and Wait',
};
function id(seed) {
  const h = crypto.createHash('sha256').update(seed).digest('hex');
  return `${h.slice(0,8)}-${h.slice(8,12)}-4${h.slice(13,16)}-a${h.slice(17,20)}-${h.slice(20,32)}`;
}
function create(mode) {
  const nodes = [], connections = {};
  const description = fs.readFileSync(path.join(__dirname, `${mode}-description.md`), 'utf8').trim();
  const add = (name, type, typeVersion, position, parameters, extra = {}) => {
    const node = { parameters, id: id(`${mode}:${name}`), name, type: `n8n-nodes-base.${type}`, typeVersion, position, ...extra };
    nodes.push(node); return name;
  };
  const link = (from, to, output = 0) => {
    connections[from] ??= { main: [] };
    while (connections[from].main.length <= output) connections[from].main.push([]);
    connections[from].main[output].push({ node: to, type: 'main', index: 0 });
  };
  const js = (name, fn, pos) => add(name, 'code', 2, pos, { mode: 'runOnceForAllItems', jsCode: code(fn) });
  const note = (name, content, pos, width, height, color = 7) => add(name, 'stickyNote', 1, pos, { content, width, height, color });
  const http = (name, url, pos, { method = 'GET', auth = true, body = false, quoted = false, file = false } = {}) => {
    const parameters = { method, url, authentication: auth ? 'genericCredentialType' : 'none', ...(auth ? { genericAuthType: 'httpHeaderAuth' } : {}), options: { timeout: file ? 120000 : 60000, redirect: { redirect: { followRedirects: false } }, response: { response: { fullResponse: true, responseFormat: file ? 'file' : 'json', neverError: !file, ...(file ? { outputPropertyName: 'data' } : {}) } } } };
    if (body) Object.assign(parameters, { sendBody: true, contentType: 'json', specifyBody: 'json', jsonBody: '={{ JSON.stringify($json.request) }}' });
    if (quoted) Object.assign(parameters, { sendHeaders: true, headerParameters: { parameters: [
      { name: 'Idempotency-Key', value: '={{ $json.idempotency_key }}' },
      { name: 'X-ZelNum-Quote', value: '={{ $json.quote.quote_token }}' },
      { name: 'X-ZelNum-Quote-Amount', value: '={{ String($json.quote.total) }}' },
    ] } });
    return add(name, 'httpRequest', 4.2, pos, parameters, { retryOnFail: false, onError: 'stopWorkflow', notes: auth ? 'Select your private Header Auth credential (X-API-Key). Never paste the API key into this node or a public export.' : 'Public current product catalog. Inspect this output to choose product IDs/slugs and minimum rows.' });
  };
  const decision = (name, field, expected, pos) => add(name, 'if', 2.2, pos, {
    conditions: { options: { caseSensitive: true, leftValue: '', typeValidation: 'strict', version: 2 }, conditions: [{ id: id(`${mode}:${name}:condition`), leftValue: `={{ $json.${field} }}`, rightValue: expected, operator: { type: typeof expected === 'boolean' ? 'boolean' : 'string', operation: 'equals' } }], combinator: 'and' }, options: {},
  });
  const set = (name, fields, pos) => add(name, 'set', 3.4, pos, { mode: 'manual', assignments: { assignments: Object.entries(fields).map(([name, value]) => ({ id: id(`${mode}:field:${name}`), name, value, type: Array.isArray(value) ? 'array' : typeof value })) }, includeOtherFields: false, options: {} });
  add('Start manually', 'manualTrigger', 1, [-260,180], {});
  note('Start here — template description', `# ${titles[mode]}\n\n${description}`, [-1160,-420], 820, 1160, 1);
  if (mode === 'realtime') {
    set('Configure realtime request', { series: 'phone', identifier: '', country: 'US', product_ids: [], idempotency_key: '', execute_billable: false, max_total_usdt: 0 }, [0,180]);
    http('Get current product catalog', 'https://api.zelnum.com/api/v1/products', [260,180], { auth: false });
    js('Validate request and products', 'validateRealtime', [520,180]);
    http('Get non-billable realtime quote', "={{ 'https://api.zelnum.com/api/v1/realtime/quote/' + $json.series }}", [780,180], { method: 'POST', body: true });
    js('Review quote and expiry', 'reviewQuote', [1040,180]);
    decision('Billing explicitly enabled?', 'execute_billable', true, [1300,180]);
    js('Authorize quoted request', 'authorizeBillable', [1560,100]);
    http('Run realtime check — BILLABLE', "={{ 'https://api.zelnum.com/api/v1/realtime/check/' + $json.series }}", [1820,100], { method: 'POST', body: true, quoted: true });
    js('Prepare product verdicts for CRM', 'realtimeOutput', [2080,100]);
    js('Return quote preview — no charge', 'quotePreview', [1560,380]);
    const chain = ['Start manually','Configure realtime request','Get current product catalog','Validate request and products','Get non-billable realtime quote','Review quote and expiry','Billing explicitly enabled?','Authorize quoted request','Run realtime check — BILLABLE','Prepare product verdicts for CRM'];
    for (let i=0;i<chain.length-1;i++) link(chain[i],chain[i+1]);
    link('Billing explicitly enabled?','Return quote preview — no charge',1);
    note('Step 1 — choose a contact and products', '## 1. Configure and validate\nUse the Edit Fields node. Select 1–10 numeric realtime IDs from the current catalog, all matching `series`. Phone accepts a national number with country or a complete E.164 number. Email omits country automatically.\n\nInput is one contact per execution; no example contacts or real customer data are shipped.', [-60,-100], 670, 460);
    note('Step 2 — quote before spending', '## 2. Quote-only by default\nThe first run stops at the quote preview. Inspect cost in USDT. Set `max_total_usdt` and `execute_billable=true` only when you approve paid work. Paid execution requests a fresh quote and sends that exact body; no stale preview token is reused.', [710,-100], 690, 460);
    note('Step 3 — interpret each product verdict', '## 3. Run and route the result\nAttach your CRM or other downstream node after the output. Inspect `verification_state` and each product result. `manual_review` covers unknown/refunded/error items; do not label them invalid.\n\n`all_valid` refers only to the chosen products, not marketing consent, identity ownership, or guaranteed delivery.', [1490,-220], 760, 480);
    note('Credentials and safe retries', '## Private credential setup\nCreate one **Header Auth** credential: Name `X-API-Key`; Value your private key from [API Center](https://app.zelnum.com). Select it on the quote and paid-check HTTP nodes. The public catalog needs no credential.\n\n## Retries\nChoose a unique `idempotency_key` for each logical contact/product request; keep the same inputs and key after timeout, 409, 429 or 500. Use a new key only for a genuinely new request. Do not pin real contacts or export credentials. Saved execution data is disabled by default.\n\n[Realtime reference](https://docs.zelnum.com/realtime-check/) · [Email reference](https://docs.zelnum.com/realtime-email/) · [Errors](https://docs.zelnum.com/errors/)', [-1160,800], 820, 600);
  } else {
    set('Configure bulk request', { series: 'phone', country: 'US', product: '', identifiers: '', deduplicate: true, idempotency_key: '', execute_billable: false, max_total_usdt: 0, resume_task_id: '', max_poll_attempts: 120, poll_interval_seconds: 5 }, [0,180]);
    js('Validate bulk settings','validateBulkSettings',[260,180]);
    decision('Resume an existing task?', 'resume', true, [520,180]);
    http('Get current product catalog','https://api.zelnum.com/api/v1/products',[780,180],{auth:false});
    js('Validate request and products','validateBulkCatalog',[1040,180]);
    http('Get non-billable bulk quote','https://api.zelnum.com/api/v1/quotes/bulk',[1300,180],{method:'POST',body:true});
    js('Review quote and expiry','reviewQuote',[1560,180]);
    decision('Billing explicitly enabled?','execute_billable',true,[1820,180]);
    js('Authorize quoted request','authorizeBillable',[2080,100]);
    http('Submit bulk task — BILLABLE','https://api.zelnum.com/api/v1/detect',[2340,100],{method:'POST',body:true,quoted:true});
    js('Store returned task ID','initializeTask',[2600,100]);
    js('Return quote preview — no charge','quotePreview',[2080,380]);
    js('Prepare status request','preparePoll',[1300,800]);
    http('Get task status','={{ $json.poll_url }}',[1560,800]);
    js('Assess task status','assessTask',[1820,800]);
    decision('Result ready to download?','workflow_status','ready_to_download',[2080,800]);
    http('Get result metadata',"={{ 'https://api.zelnum.com/api/v1/tasks/' + encodeURIComponent($json.task_id) + '/result' }}",[2340,740]);
    js('Validate result URL and expiry','validateDownloadURL',[2600,740]);
    http('Download authenticated ZIP or CSV','={{ $json.download_url }}',[2860,740],{file:true});
    js('Reject failed or empty download','validateBinary',[3120,740]);
    decision('Continue bounded polling?','workflow_status','poll_again',[2080,1080]);
    add('Wait before next status check','wait',1.1,[1820,1260],{resume:'timeInterval',amount:'={{ $json.poll_interval_seconds }}',unit:'seconds'},{webhookId:id('bulk:wait')});
    js('Return terminal task status','terminalStatus',[2340,1140]);
    const initial=['Start manually','Configure bulk request','Validate bulk settings','Resume an existing task?'];
    for(let i=0;i<initial.length-1;i++)link(initial[i],initial[i+1]);
    link('Resume an existing task?','Prepare status request');
    link('Resume an existing task?','Get current product catalog',1);
    const submit=['Get current product catalog','Validate request and products','Get non-billable bulk quote','Review quote and expiry','Billing explicitly enabled?','Authorize quoted request','Submit bulk task — BILLABLE','Store returned task ID','Prepare status request'];
    for(let i=0;i<submit.length-1;i++)link(submit[i],submit[i+1]);
    link('Billing explicitly enabled?','Return quote preview — no charge',1);
    const poll=['Prepare status request','Get task status','Assess task status','Result ready to download?','Get result metadata','Validate result URL and expiry','Download authenticated ZIP or CSV','Reject failed or empty download'];
    for(let i=0;i<poll.length-1;i++)link(poll[i],poll[i+1]);
    link('Result ready to download?','Continue bounded polling?',1);
    link('Continue bounded polling?','Wait before next status check');
    link('Continue bounded polling?','Return terminal task status',1);
    link('Wait before next status check','Prepare status request');
    note('Step 1 — configure a batch or resume', '## 1. Configure your own list\nThe Edit Fields node accepts comma/newline-separated contacts (one series per batch). Normalization and optional deduplication report removed duplicates. Select a current async product slug; do not guess its minimum. This quoted-array flow supports 10,000 input rows.\n\n**Resume:** set only `resume_task_id` and polling settings to inspect an existing task without quoting or submitting again.', [-60,-130], 700, 550);
    note('Step 2 — current minimum and safe quote', '## 2. Check the minimum and quote\nThe catalog supplies the current product-specific minimum; validation applies it after optional deduplication. Do not pad lists with dummy contacts. Phone country is required; email omits it.\n\n`execute_billable=false` ends at a price preview. A paid run requests a fresh quote and must fit `max_total_usdt`.', [710,-130], 1200, 550);
    note('Step 3 — explicit paid submission', '## 3. Submit once, save the task ID\nPaid submission sends the exact quoted body, quote headers, and your stable idempotency key. The HTTP node does not retry automatically. Keep the same inputs/key after uncertain errors. Save `task_id` before closing the run; it is your handle for recovery.\n\nUse a separate new key for a genuinely new batch.', [2020,-180], 750, 650);
    note('Step 4 — poll, recover and download', '## 4. Bounded polling and safe download\nOne task is polled every 3–5 seconds, at most `max_poll_attempts` times. Network time adds to the interval; the workflow has a 30-minute execution limit. Failed tasks and completed-but-expired/unavailable results go to terminal output, not another polling cycle.\n\nOnly an exact `api.zelnum.com` result URL receives your credential; redirects are disabled. ZIP/CSV must have a successful, non-empty binary response. The final `data` binary can be downloaded in n8n or connected to your own storage node. No explicit file writer is included.', [1230,540], 2130, 940);
    note('Credentials, product limits and privacy', '## Private credential setup\nCreate Header Auth: Name `X-API-Key`; Value your private Zelnum key from [API Center](https://app.zelnum.com). Select the same credential on the five authenticated HTTP nodes: quote, submit, status, metadata, download. The public catalog needs no credential.\n\n## Recovery and privacy\nA polling limit does not cancel the remote task. Save its ID and use `resume_task_id`; do not create another paid submission. Download before API `expires_at`. A 404 may mean expired, missing, or inaccessible; 422 means validation/not-ready, not expiry.\n\nOnly process contacts you have a lawful basis to use. Execution saving is disabled by default; never pin real lists or export credentials. Use a streaming client for files too large for your n8n memory.\n\n[Bulk reference](https://docs.zelnum.com/async-detection/) · [Results and retention](https://docs.zelnum.com/async-detection/result/) · [Errors](https://docs.zelnum.com/errors/)', [-1160,800], 820, 780);
  }
  return { name: titles[mode], nodes, connections, active: false, settings: { executionOrder: 'v1', timezone: 'UTC', saveDataSuccessExecution: 'none', saveDataErrorExecution: 'none', saveManualExecutions: false, saveExecutionProgress: false, executionTimeout: 1800 }, pinData: {}, meta: { templateCredsSetupCompleted: false }, tags: [] };
}
function build() { return { 'zelnum-realtime.n8n.json': create('realtime'), 'zelnum-bulk.n8n.json': create('bulk') }; }
if (require.main === module) {
  const workflows = build();
  if (process.argv.includes('--emit')) process.stdout.write(JSON.stringify(workflows));
  else {
    for (const [file, expected] of Object.entries(workflows)) {
      const actual = JSON.parse(fs.readFileSync(path.join(__dirname,file),'utf8'));
      if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error(`Generated file differs: ${file}`);
      console.log(`PASS deterministic build: ${file}`);
    }
  }
}
module.exports = { build, titles };

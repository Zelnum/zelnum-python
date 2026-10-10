const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
let checks = 0;
function check(name, fn) { fn(); checks++; console.log('PASS ' + name); }
function harness(mode) {
  const nodes = JSON.parse(fs.readFileSync(path.join(__dirname, `zelnum-${mode}-verification.json`), 'utf8'));
  const ids = new Set(nodes.map(n => n.id));
  assert.equal(ids.size, nodes.length);
  for (const n of nodes) {
    for (const wire of n.wires || []) for (const id of wire) assert.ok(ids.has(id), id);
    if (n.type === 'function') new Function('msg', 'env', 'flow', 'node', 'Buffer', n.func);
    if (n.type === 'inject') assert.equal(n.once, false);
  }
  const env = { ZELNUM_API_KEY: 'mock-private-key', ZELNUM_SERIES: 'phone', ZELNUM_IDENTIFIER: '+14155550101', ZELNUM_REALTIME_PRODUCT_ID: '1', ZELNUM_COUNTRY: 'US', ZELNUM_IDEMPOTENCY_KEY: mode + '-request-1', ZELNUM_BULK_SERIES: 'phone', ZELNUM_BULK_PRODUCT: 'bulk-test', ZELNUM_IDENTIFIERS: '+14155550101,+14155550102' };
  const state = new Map(), errors = [];
  const run = (id, msg = {}) => new Function('msg', 'env', 'flow', 'node', 'Buffer', nodes.find(n => n.id === id).func)(msg, {get: k => env[k]}, {get: k => state.get(k), set: (k, v) => state.set(k, v)}, {error: s => errors.push(s)}, Buffer);
  const quote = () => {
    if (mode === 'bulk') run('bulk-save-products', {statusCode:200, payload:{data:[{slug:'bulk-test',mode:'async',series:env.ZELNUM_BULK_SERIES,min_phones:2}]}});
    const request = run(mode === 'bulk' ? 'bulk-build-quote' : 'rt-build-quote');
    assert.ok(request);
    run(mode === 'bulk' ? 'bulk-save-quote' : 'rt-save-quote', {...request,statusCode:200,payload:{quote:{quote_token:'mock-quote',total:0.1,expires_at:new Date(Date.now()+300000).toISOString()}}});
    return request;
  };
  return {nodes,env,state,errors,run,quote};
}
for (const mode of ['realtime','bulk']) {
  const h = harness(mode), build = mode === 'bulk' ? 'bulk-build-submit' : 'rt-build-check';
  const key = mode === 'bulk' ? 'zelnumBulkQuote' : 'zelnumRealtimeQuote';
  check(mode + ': syntax, wires and manual billing', () => assert.ok(h.nodes.length));
  check(mode + ': execution requires a quote', () => assert.equal(h.run(build), null));
  let req = h.quote();
  check(mode + ': exact quoted body and headers', () => {const x=h.run(build);assert.deepEqual(x.payload,req.payload);assert.equal(x.headers['X-ZelNum-Quote'],'mock-quote');});
  check(mode + ': stable key retry', () => assert.ok(h.run(build)));
  check(mode + ': changed key on executed quote blocked', () => {h.env.ZELNUM_IDEMPOTENCY_KEY='another';assert.equal(h.run(build),null);h.env.ZELNUM_IDEMPOTENCY_KEY=mode+'-request-1';});
  for (const [field,value] of mode === 'bulk' ? [['ZELNUM_COUNTRY','GB'],['ZELNUM_BULK_PRODUCT','different'],['ZELNUM_IDENTIFIERS','a,b,c'],['ZELNUM_BULK_SERIES','email']] : [['ZELNUM_COUNTRY','GB'],['ZELNUM_REALTIME_PRODUCT_ID','2'],['ZELNUM_IDENTIFIER','different'],['ZELNUM_SERIES','email']]) {
    check(mode + ': changing ' + field + ' blocked', () => {const old=h.env[field];h.env[field]=value;assert.equal(h.run(build),null);h.env[field]=old;});
  }
  check(mode + ': expired quote blocked', () => {h.state.get(key).quote.expires_at=new Date(0).toISOString();assert.equal(h.run(build),null);});
  check(mode + ': new quote clears stale quote even on failure', () => {h.env.ZELNUM_API_KEY='';assert.equal(h.run(mode==='bulk'?'bulk-build-quote':'rt-build-quote'),null);assert.equal(h.state.get(key),undefined);h.env.ZELNUM_API_KEY='mock-private-key';});
  check(mode + ': email omits country', () => {h.env.ZELNUM_SERIES='email';h.env.ZELNUM_BULK_SERIES='email';h.env.ZELNUM_IDENTIFIER='a@example.com';h.env.ZELNUM_IDENTIFIERS='a@example.com,b@example.com';req=h.quote();assert.ok(!('country' in req.payload));assert.deepEqual(h.run(build).payload,req.payload);});
}
const b = harness('bulk');
check('bulk: minimum metadata required', () => assert.equal(b.run('bulk-build-quote'),null));
b.run('bulk-save-products',{statusCode:200,payload:{data:[{slug:'bulk-test',series:'phone',mode:'async',min_phones:500}]}});
check('bulk: two sample rows rejected before API call', () => {assert.equal(b.run('bulk-build-quote'),null);assert.match(b.errors.at(-1),/500/);});
check('bulk: blank list rejected', () => {b.env.ZELNUM_IDENTIFIERS='';assert.equal(b.run('bulk-build-quote'),null);});
check('bulk: newline-separated real list supported', () => {b.env.ZELNUM_IDENTIFIERS=Array.from({length:500},(_,i)=>String(14155550000+i)).join('\n');assert.equal(b.run('bulk-build-quote').payload.phones.length,500);});
check('bulk: failed submission does not replace saved task', () => {b.state.set('zelnumBulkTaskId','existing');assert.equal(b.run('bulk-save-task',{statusCode:403,payload:{message:'denied'}}),null);assert.equal(b.state.get('zelnumBulkTaskId'),'existing');});
check('bulk: submit stores task ID', () => {b.run('bulk-save-task',{statusCode:202,payload:{task_id:'task-1'}});assert.equal(b.state.get('zelnumBulkTaskId'),'task-1');});
check('bulk: resume task after restart', () => {b.env.ZELNUM_TASK_ID='resume';assert.match(b.run('bulk-build-status').url,/resume$/);b.env.ZELNUM_TASK_ID='';});
check('bulk: completed unavailable result is not processing', () => {const m=b.run('bulk-check-status',{statusCode:200,payload:{task_id:'task-1',status:'completed',result_available:false}});assert.match(m.payload.notice,/expired/);assert.equal(m.payload.status,'completed');});
check('bulk: result metadata route', () => assert.match(b.run('bulk-build-result').url,/task-1\/result$/));
check('bulk: expired and not-ready distinguished', () => {assert.equal(b.run('bulk-build-download',{statusCode:404,payload:{code:'result_expired'}}),null);assert.match(b.errors.at(-1),/expired/);assert.equal(b.run('bulk-build-download',{statusCode:422,payload:{code:'result_not_ready'}}),null);assert.match(b.errors.at(-1),/not ready/);});
check('bulk: unexpected download host blocked', () => assert.equal(b.run('bulk-build-download',{statusCode:200,zelnumTaskId:'task-1',payload:{download_url:'https://other.invalid/file'}}),null));
check('bulk: authenticated download request', () => {const m=b.run('bulk-build-download',{statusCode:200,zelnumTaskId:'task-1',payload:{download_url:'https://api.zelnum.com/api/v1/tasks/task-1/download'}});assert.equal(m.headers['X-API-Key'],'mock-private-key');assert.equal(m.payload,undefined);});
for (const [status,payload] of [[404,Buffer.from('error')],[200,Buffer.alloc(0)],[200,'wrong type']]) check('bulk: invalid download '+status+' / '+typeof payload, () => assert.equal(b.run('bulk-validate-download',{statusCode:status,payload}),null));
check('bulk: ZIP/CSV buffer accepted without writing files', () => {for(const [content,suffix] of [['PKmock','.zip'],['header\nrow','.csv']]) {const m=b.run('bulk-validate-download',{statusCode:200,payload:Buffer.from(content),zelnumTaskId:'task-1',zelnumResult:{expires_at:null},headers:{'X-API-Key':'mock'}});assert.ok(m.filename.endsWith(suffix));assert.ok(m.zelnumDownload.bytes>0);assert.equal(m.headers,undefined);}});
console.log(`${checks} checks passed. Mock API responses only; no billable requests sent.`);

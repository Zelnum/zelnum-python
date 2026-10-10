'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { build } = require('./build.cjs');
const { code } = require('./src/runtime.cjs');
const AsyncFunction = Object.getPrototypeOf(async function(){}).constructor;
const workflows = build();
const official = process.env.ZELNUM_N8N_WORKFLOW_LIBRARY ? require(process.env.ZELNUM_N8N_WORKFLOW_LIBRARY) : null;
let checks = 0;
async function test(name, fn) { await fn(); checks++; console.log(`PASS ${name}`); }
const clone = value => JSON.parse(JSON.stringify(value));
const future = () => new Date(Date.now()+300000).toISOString();
const expired = () => new Date(Date.now()-1000).toISOString();
const quote = (extra = {}) => ({ currency:'USDT', total:0.05, quote_token:'mock-quote-not-a-real-token', expires_at:future(), ...extra });
const ok = body => ({statusCode:200, body});
const catalog = {data:[{id:47,mode:'realtime',series:'phone',slug:'mock-rt-phone'},{id:49,mode:'realtime',series:'email',slug:'mock-rt-email'},{id:80,mode:'async',series:'phone',slug:'mock-bulk-phone',min_phones:500},{id:81,mode:'async',series:'email',slug:'mock-bulk-email',min_phones:500}]};
const rtConfig = (extra={}) => ({series:'phone',identifier:'+12025550123',country:'US',product_ids:[47],idempotency_key:'test-realtime-001',execute_billable:false,max_total_usdt:0.1,...extra});
// Fictional values remain in test code only, never in the published templates.
const bulkConfig = (extra={}) => ({series:'phone',country:'US',product:'mock-bulk-phone',identifiers:Array.from({length:500},(_,i)=>`+1202555${String(i).padStart(4,'0')}`),deduplicate:true,idempotency_key:'test-bulk-001',execute_billable:false,max_total_usdt:0.1,resume_task_id:'',max_poll_attempts:3,poll_interval_seconds:5,...extra});
function references(map) { return name => { if (!(name in map)) throw new Error(`Missing paired node data: ${name}`); const item = map[name]; return { first:()=>item, item, all:()=>[item] }; }; }
async function run(fn, json, refs={}, binary=null, bytes=null) {
  const item={json,...(binary?{binary}: {})};
  const input={first:()=>item,all:()=>[item]};
  const helpers={getBinaryDataBuffer:async(index,property)=>{assert.equal(index,0);assert.equal(property,'data');return bytes;}};
  const result=await new AsyncFunction('$input','$',code(fn)).call({helpers},input,references(refs));
  assert.equal(result.length,1);
  assert.deepEqual(result[0].pairedItem,{item:0});
  return result[0];
}
const evalExpr = (value, item, refs) => typeof value==='string' && value.startsWith('=')
  ? new Function('$json','$',`return (${value.slice(1).trim().replace(/^\{\{([\s\S]*)\}\}$/,'$1')});`)(item.json,references(refs)) : value;
async function simulate(mode, config, api) {
  const wf=workflows[`zelnum-${mode}.n8n.json`], nodes=Object.fromEntries(wf.nodes.map(n=>[n.name,n]));
  const refs={}, calls=[], visited=[], queue=[['Start manually',{json:{}},null]], terminals=[];
  const model=official?new official.Workflow({id:'mock-graph',nodes:clone(wf.nodes),connections:wf.connections,settings:wf.settings,active:false,nodeTypes:{getByNameAndVersion:()=>undefined}}):null;
  const execution={startData:{},resultData:{runData:{}},executionData:{contextData:{},nodeExecutionStack:[],waitingExecution:{},waitingExecutionSource:{}}};
  let rounds=0;
  while(queue.length) {
    if(++rounds>5000)throw new Error('Unbounded workflow loop.');
    const [name,item,source]=queue.shift(), node=nodes[name]; visited.push(name);
    const runIndex=execution.resultData.runData[name]?.length??0;
    const executeData={node,data:{main:[item]},source:{main:[source]}};
    const proxy=official?new official.WorkflowDataProxy(model,execution,runIndex,0,name,[item],node.parameters,'manual',{executionId:'mock'},executeData).getDataProxy():null;
    const evaluate=value=>official && typeof value==='string' && value.startsWith('=')?model.expression.getParameterValue(value,execution,runIndex,0,name,[item],'manual',{executionId:'mock'},executeData):evalExpr(value,item,refs);
    let out=item, output=0;
    if(node.type.endsWith('.set')) out={json:clone(config)};
    else if(node.type.endsWith('.code')) {
      out=(await new AsyncFunction('$input','$',node.parameters.jsCode).call({helpers:{getBinaryDataBuffer:async()=>Buffer.from(item.binary.data.data,'base64')}},proxy?.$input??{first:()=>item,all:()=>[item]},proxy?.$??references(refs)))[0];
    } else if(node.type.endsWith('.if')) {
      const cond=node.parameters.conditions.conditions[0]; output=evaluate(cond.leftValue)===cond.rightValue?0:1;
    } else if(node.type.endsWith('.httpRequest')) {
      const request={name,method:node.parameters.method,url:evaluate(node.parameters.url),body:node.parameters.sendBody?JSON.parse(evaluate(node.parameters.jsonBody)):null,headers:Object.fromEntries((node.parameters.headerParameters?.parameters??[]).map(p=>[p.name,evaluate(p.value)]))};
      calls.push(clone(request)); out=await api(request,calls.length);out.pairedItem={item:0};
    }
    assert.ok(out?.json,`${name} emits an item`); refs[name]=out;
    const ports=Array.from({length:node.type.endsWith('.if')?2:1},()=>[]);ports[output]=[out];
    (execution.resultData.runData[name]??=[]).push({startTime:Date.now(),executionTime:1,source:executeData.source.main,data:{main:ports}});
    const next=wf.connections[name]?.main[output]??[];
    if(next.length===0)terminals.push(out);
    for(const target of next)queue.push([target.node,out,{previousNode:name,previousNodeOutput:output,previousNodeRun:runIndex}]);
  }
  return {terminals,calls,visited};
}
const realtimeResult = (extra={}) => ({request_id:'mock-request-id',series:'phone',identifier:'+12025550123',status:'succeeded',replayed:false,charged_amount:0.05,refunded_amount:0,results:[{product_id:47,result:'valid',billing_status:'charged',cached:false,error_code:null}],...extra});
function apiMock({statusSequence=['completed'], downloadBytes=Buffer.from('identifier,result\n+12025550123,valid\n'), mime='text/csv', realtime=realtimeResult()}={}) {
  let polls=0;
  return async request=>{
    if(request.url.endsWith('/products'))return {json:ok(catalog)};
    if(request.url.includes('/quote/')||request.url.endsWith('/quotes/bulk'))return {json:ok({quote:quote()})};
    if(request.url.includes('/realtime/check/'))return {json:ok(realtime)};
    if(request.url.endsWith('/detect'))return {json:{statusCode:202,body:{task_id:'mock-task-001',idempotent_replay:false}}};
    if(request.url.endsWith('/result'))return {json:ok({task_id:'mock-task-001',download_url:'https://api.zelnum.com/api/v1/tasks/mock-task-001/download',expires_at:future(),summary:{total:500,valid:499,unknown:1}})};
    if(request.url.endsWith('/download'))return {json:{statusCode:200,headers:{'content-disposition':'attachment; filename="result.csv"'}},binary:{data:{data:downloadBytes.toString('base64'),mimeType:mime}}};
    const status=statusSequence[Math.min(polls++,statusSequence.length-1)];
    return {json:ok({task_id:'mock-task-001',status,result_available:status==='completed',result_expires_at:future(),failure_message:status==='failed'?'mock supplier failure':null,progress:status==='completed'?100:50})};
  };
}
async function main() {
  for(const [file,wf] of Object.entries(workflows)) {
    await test(`${file}: reproducible artifact and import structure`,()=>{
      assert.deepEqual(JSON.parse(fs.readFileSync(path.join(__dirname,file),'utf8')),wf);
      assert.equal(new Set(wf.nodes.map(n=>n.name)).size,wf.nodes.length);assert.equal(new Set(wf.nodes.map(n=>n.id)).size,wf.nodes.length);
      const names=new Set(wf.nodes.map(n=>n.name));
      for(const [from,ports]of Object.entries(wf.connections)){assert.ok(names.has(from));for(const list of ports.main)for(const to of list){assert.ok(names.has(to.node));assert.equal(to.type,'main');assert.equal(to.index,0);}}
      assert.equal(wf.active,false);assert.deepEqual(wf.pinData,{});assert.equal(wf.settings.saveManualExecutions,false);
      for(const node of wf.nodes){assert.ok(node.type.startsWith('n8n-nodes-base.'));assert.equal(node.credentials,undefined);if(node.type.endsWith('.code'))new AsyncFunction('$input','$',node.parameters.jsCode);if(node.type.endsWith('.httpRequest')){assert.equal(node.retryOnFail,false);assert.equal(node.parameters.options.redirect.redirect.followRedirects,false);assert.equal(node.parameters.options.response.response.fullResponse,true);}}
      assert.equal(wf.nodes.filter(n=>n.type.endsWith('.manualTrigger')).length,1);
      assert.equal(wf.nodes.some(n=>/webhook|writeBinaryFile|readWriteFile|executeCommand/i.test(n.type)),false);
      const reachable=new Set(),visit=n=>{if(reachable.has(n))return;reachable.add(n);for(const links of wf.connections[n]?.main??[])for(const target of links)visit(target.node);};visit('Start manually');
      for(const node of wf.nodes.filter(n=>!n.type.endsWith('.stickyNote')))assert.ok(reachable.has(node.name),node.name);
    });
    await test(`${file}: reviewer notes, safe defaults and website links`,()=>{
      const sticky=wf.nodes.find(n=>n.name==='Start here — template description');assert.equal(sticky.parameters.color,1);
      const desc=fs.readFileSync(path.join(__dirname,file.includes('realtime')?'realtime-description.md':'bulk-description.md'),'utf8').trim();assert.ok(sticky.parameters.content.includes(desc));
      for(const url of ['https://zelnum.com','https://app.zelnum.com','https://docs.zelnum.com'])assert.ok(desc.includes(url));assert.equal(/<[^>]+>/.test(desc),false);
      const settings=wf.nodes.find(n=>n.type.endsWith('.set')).parameters.assignments.assignments;assert.equal(settings.find(f=>f.name==='execute_billable').value,false);assert.equal(settings.find(f=>f.name==='idempotency_key').value,'');
      assert.equal(JSON.stringify(wf).includes('mock-task'),false);assert.equal(JSON.stringify(wf).includes('+12025550123'),false);
    });
  }
  await test('realtime quote-only path never calls paid endpoint',async()=>{const r=await simulate('realtime',rtConfig(),apiMock());assert.equal(r.terminals[0].json.status,'quote_only');assert.equal(r.calls.length,2);assert.equal(JSON.stringify(r.terminals).includes('quote_token'),false);});
  await test('realtime paid flow uses exact quote body and stable headers',async()=>{const r=await simulate('realtime',rtConfig({execute_billable:true}),apiMock());assert.deepEqual(r.calls[1].body,r.calls[2].body);assert.equal(r.calls[2].headers['Idempotency-Key'],'test-realtime-001');assert.equal(r.calls[2].headers['X-ZelNum-Quote-Amount'],'0.05');assert.equal(r.terminals[0].json.verification_state,'all_valid');});
  await test('realtime email omits country in both requests',async()=>{const r=await simulate('realtime',rtConfig({series:'email',identifier:'test@example.com',product_ids:[49],execute_billable:true}),apiMock({realtime:realtimeResult({series:'email',identifier:'test@example.com',results:[{product_id:49,result:'valid',billing_status:'charged',error_code:null}]})}));for(const request of r.calls.filter(x=>x.body))assert.equal('country'in request.body,false);});
  await test('realtime invalid verdict is distinct from unknown/refunded',async()=>{const invalid=await simulate('realtime',rtConfig({execute_billable:true}),apiMock({realtime:realtimeResult({results:[{product_id:47,result:'invalid',billing_status:'charged',error_code:null}]})}));assert.equal(invalid.terminals[0].json.verification_state,'all_invalid');const unknown=await simulate('realtime',rtConfig({execute_billable:true}),apiMock({realtime:realtimeResult({status:'failed',results:[{product_id:47,result:'unknown',billing_status:'refunded',error_code:'provider_timeout'}]})}));assert.equal(unknown.terminals[0].json.verification_state,'manual_review');assert.equal(unknown.terminals[0].json.all_selected_products_valid,false);});
  await test('realtime rejects wrong series/catalog, blank and malformed contact',async()=>{for(const bad of [{product_ids:[80]},{product_ids:[49]},{product_ids:[47,47]},{product_ids:[]},{identifier:''},{identifier:'+0000000000'},{series:'other'},{series:'email',product_ids:[49],identifier:'not-email'},{identifier:'2025550123',country:''}])await assert.rejects(()=>simulate('realtime',rtConfig(bad),apiMock()));});
  await test('approval and spend cap block the paid branch',async()=>{for(const bad of [{execute_billable:'true'},{execute_billable:true,idempotency_key:''},{execute_billable:true,max_total_usdt:0.01},{execute_billable:true,max_total_usdt:NaN},{idempotency_key:'x'.repeat(192)}])await assert.rejects(()=>simulate('realtime',rtConfig(bad),apiMock()));});
  const rtState=(await run('validateRealtime',ok(catalog),{'Configure realtime request':{json:rtConfig({execute_billable:true})}})).json;
  await test('quote rejects missing token, total, currency and invalid/expired time',async()=>{for(const bad of [{quote_token:''},{total:null},{total:''},{total:-1},{currency:'USD'},{expires_at:expired()},{expires_at:'bad'}])await assert.rejects(()=>run('reviewQuote',ok({quote:quote(bad)}),{'Validate request and products':{json:rtState}}));});
  await test('authorization rechecks expiry and does not reread changed fields',async()=>{const stale={...rtState,quote:quote({expires_at:expired()})};await assert.rejects(()=>run('authorizeBillable',stale));const unchanged=await run('authorizeBillable',{...rtState,quote:quote()},{'Configure realtime request':{json:rtConfig({identifier:'+19999999999'})}});assert.deepEqual(unchanged.json.request,rtState.request);});
  await test('authorization cannot bypass malformed quote or settings',async()=>{for(const bad of [{quote:quote({expires_at:'bad'})},{quote:quote({total:null})},{max_total_usdt:NaN},{execute_billable:'true'},{idempotency_key:'invalid key'}])await assert.rejects(()=>run('authorizeBillable',{...rtState,quote:quote(),...bad}));});
  await test('partial or failed status never becomes an all-valid result',async()=>{for(const status of ['partial_succeeded','failed']){const out=await run('realtimeOutput',ok(realtimeResult({status})),{'Authorize quoted request':{json:rtState}});assert.equal(out.json.verification_state,'manual_review');assert.equal(out.json.all_selected_products_valid,false);}});
  await test('multi-product mixed verdicts remain explicit',async()=>{const out=await run('realtimeOutput',ok(realtimeResult({results:[{product_id:47,result:'valid',billing_status:'charged',error_code:null},{product_id:48,result:'invalid',billing_status:'charged',error_code:null}]})),{'Authorize quoted request':{json:{...rtState,request:{...rtState.request,product_ids:[47,48]}}}});assert.equal(out.json.verification_state,'mixed_verdicts');});
  await test('manual retry uses the same body/key and preserves server replay result',async()=>{const cfg=rtConfig({execute_billable:true});const a=await simulate('realtime',cfg,apiMock());const b=await simulate('realtime',cfg,apiMock({realtime:realtimeResult({replayed:true,charged_amount:0})}));assert.deepEqual(a.calls[2].body,b.calls[2].body);assert.equal(a.calls[2].headers['Idempotency-Key'],b.calls[2].headers['Idempotency-Key']);assert.equal(b.terminals[0].json.replayed,true);});
  await test('realtime mismatched response products/identity cannot become a success',async()=>{for(const bad of [{results:[]},{identifier:'different'},{series:'email'},{request_id:''},{results:[{product_id:49,result:'valid',billing_status:'charged'}]}])await assert.rejects(()=>run('realtimeOutput',ok(realtimeResult(bad)),{'Authorize quoted request':{json:rtState}}));});
  await test('bulk quote-only validates catalog and never submits a task',async()=>{const r=await simulate('bulk',bulkConfig(),apiMock());assert.equal(r.terminals[0].json.status,'quote_only');assert.equal(r.calls.length,2);assert.equal(r.terminals[0].json.submitted_count,500);});
  await test('bulk complete path polls one task then downloads authenticated binary',async()=>{const r=await simulate('bulk',bulkConfig({execute_billable:true}),apiMock({statusSequence:['pending','processing','completed']}));assert.equal(r.calls.filter(c=>c.url.endsWith('/detect')).length,1);const submits=r.calls.filter(c=>c.body);assert.deepEqual(submits[0].body,submits[1].body);assert.equal(submits[1].headers['Idempotency-Key'],'test-bulk-001');assert.equal(r.visited.filter(n=>n==='Wait before next status check').length,2);assert.equal(r.terminals[0].json.status,'downloaded');assert.equal(r.terminals[0].json.poll_attempts,3);assert.ok(r.terminals[0].binary.data);});
  await test('bulk accepts email and omits country on both POST bodies',async()=>{const r=await simulate('bulk',bulkConfig({series:'email',product:'mock-bulk-email',identifiers:Array.from({length:500},(_,i)=>`lead${i}@example.com`),execute_billable:true}),apiMock());for(const c of r.calls.filter(c=>c.body))assert.equal('country'in c.body,false);});
  await test('bulk reports normalization and deduplication, applies minimum afterwards',async()=>{const cfg=bulkConfig();cfg.identifiers.push(' +1 (202) 555-0000 ');const r=await simulate('bulk',cfg,apiMock());assert.equal(r.terminals[0].json.duplicates_removed,1);await assert.rejects(()=>simulate('bulk',bulkConfig({identifiers:Array(500).fill('+12025550123')}),apiMock()),/at least 500/);});
  await test('bulk rejects dummy-size, blank, oversized, wrong product and malformed lists',async()=>{for(const bad of [{identifiers:''},{identifiers:['+12025550123','+12025550124']},{identifiers:Array(10001).fill('+12025550123')},{product:'missing'},{country:''},{deduplicate:'false'},{identifiers:[123]},{identifiers:['not-a-number']}])await assert.rejects(()=>simulate('bulk',bulkConfig(bad),apiMock()));});
  await test('bulk newline contacts work; intentional non-deduplication is explicit',async()=>{const cfg=bulkConfig();const s=await simulate('bulk',bulkConfig({identifiers:cfg.identifiers.join('\n')}),apiMock());assert.equal(s.terminals[0].json.submitted_count,500);const noDedup=await simulate('bulk',bulkConfig({identifiers:Array(500).fill('+12025550123'),deduplicate:false}),apiMock());assert.equal(noDedup.terminals[0].json.duplicates_removed,0);});
  await test('resume route ignores billing inputs and does not submit/quote/catalog',async()=>{const r=await simulate('bulk',bulkConfig({resume_task_id:'mock-task-001',identifiers:'',product:'',execute_billable:true,idempotency_key:''}),apiMock());assert.equal(r.calls.length,3);assert.equal(r.calls.some(c=>c.method==='POST'),false);assert.equal(r.terminals[0].json.status,'downloaded');});
  await test('task failures do not poll forever or download',async()=>{const r=await simulate('bulk',bulkConfig({resume_task_id:'mock-task-001'}),apiMock({statusSequence:['failed']}));assert.equal(r.calls.length,1);assert.equal(r.terminals[0].json.status,'task_failed');assert.equal(r.terminals[0].json.failure_message,'mock supplier failure');});
  await test('poll limit returns task ID for recovery, no automatic resubmission',async()=>{const r=await simulate('bulk',bulkConfig({resume_task_id:'mock-task-001'}),apiMock({statusSequence:['processing']}));assert.equal(r.calls.length,3);assert.equal(r.terminals[0].json.status,'poll_limit_reached');assert.equal(r.terminals[0].json.task_id,'mock-task-001');});
  const pollState={task_id:'mock-task-001',poll_attempt:1,max_poll_attempts:3,poll_interval_seconds:5};
  await test('completed expired/unavailable results are terminal, not pending',async()=>{for(const [available,date,expected]of [[false,future(),'completed_result_unavailable'],[true,expired(),'completed_result_expired']]){const out=await run('assessTask',ok({task_id:'mock-task-001',status:'completed',result_available:available,result_expires_at:date}),{'Prepare status request':{json:pollState}});assert.equal(out.json.workflow_status,expected);}});
  await test('invalid task ID/status, polling intervals and limits are rejected',async()=>{for(const bad of [{resume_task_id:'../etc/passwd'},{poll_interval_seconds:1},{max_poll_attempts:0},{max_poll_attempts:361}])await assert.rejects(()=>simulate('bulk',bulkConfig(bad),apiMock()));await assert.rejects(()=>run('assessTask',ok({task_id:'wrong',status:'completed'}),{'Prepare status request':{json:pollState}}));await assert.rejects(()=>run('assessTask',ok({task_id:'mock-task-001',status:'invented'}),{'Prepare status request':{json:pollState}}));});
  await test('metadata rejects expired time, wrong task, foreign host/path and URL tricks',async()=>{for(const bad of [{expires_at:expired()},{expires_at:'bad'},{task_id:'wrong'},{download_url:'https://evil.example/result'},{download_url:'https://api.zelnum.com@evil.example/result'},{download_url:'https://api.zelnum.com/api/v1/tasks/mock-task-001/download?redirect=evil'}])await assert.rejects(()=>run('validateDownloadURL',ok({task_id:'mock-task-001',download_url:'https://api.zelnum.com/api/v1/tasks/mock-task-001/download',expires_at:future(),...bad}),{'Assess task status':{json:pollState}}));});
  await test('404 expiry/missing differs from 422 not-ready; no blind paid retries',async()=>{for(const status of [400,401,402,403,404,409,422,429,500,503])await assert.rejects(()=>run('reviewQuote',{statusCode:status,body:{code:status===422?'result_not_ready':'mock_error'}},{'Validate request and products':{json:rtState}}),new RegExp(`HTTP ${status}`));});
  const downloadRef={'Validate result URL and expiry':{json:{task_id:'mock-task-001',download_url:'https://api.zelnum.com/api/v1/tasks/mock-task-001/download'}}};
  await test('download rejects errors, empty file, HTML/JSON and broken ZIP header',async()=>{for(const [status,mime,bytes]of [[404,'text/csv',Buffer.from('a,b\n')],[200,'text/csv',Buffer.alloc(0)],[200,'text/html',Buffer.from('<html>error</html>')],[200,'application/json',Buffer.from('{"code":"failed"}')],[200,'text/csv',Buffer.from('{"code":"failed"}')],[200,'application/zip',Buffer.from('PK')]])await assert.rejects(()=>run('validateBinary',{statusCode:status},downloadRef,{data:{mimeType:mime,data:'filesystem-storage-reference'}},bytes));});
  await test('valid CSV, MIME-fallback CSV and ZIP use the n8n binary helper',async()=>{for(const [mime,bytes]of [['text/csv',Buffer.from('identifier,result\na,valid\n')],['text/plain',Buffer.from('identifier,result\na,valid\n')],['application/zip',Buffer.concat([Buffer.from([0x50,0x4b,3,4]),Buffer.alloc(30)])]]){const r=await run('validateBinary',{statusCode:200,headers:{'content-disposition':'attachment; filename="result.csv"'}},downloadRef,{data:{mimeType:mime,data:'filesystem-storage-reference'}},bytes);assert.equal(r.json.status,'downloaded');assert.equal(r.json.bytes,bytes.length);assert.ok(r.binary.data.fileName.endsWith(mime==='application/zip'?'.zip':'.csv'));}});
  const library=process.env.ZELNUM_N8N_WORKFLOW_LIBRARY;
  if(library) {
    const {Workflow,INodeParametersSchema}=require(library);
    for(const [file,wf]of Object.entries(workflows)) await test(`${file}: official n8n Workflow model and parameter schema`,()=>{
      for(const node of wf.nodes)assert.ok(INodeParametersSchema.safeParse(node.parameters).success,node.name);
      const model=new Workflow({id:'test-only',name:wf.name,nodes:clone(wf.nodes),connections:wf.connections,settings:wf.settings,active:false,nodeTypes:{getByNameAndVersion:()=>undefined}});
      assert.equal(Object.keys(model.nodes).length,wf.nodes.length);assert.ok(model.connectionsByDestinationNode['Authorize quoted request']);
    });
  }
  console.log(`${checks} groups passed. Mock execution of exported Code/expressions/connections; no paid requests, no real credentials. ${library?'Official graph/schema checks included.':'Set ZELNUM_N8N_WORKFLOW_LIBRARY for optional official graph/schema checks.'}`);
}
main().catch(error=>{console.error(error);process.exitCode=1;});

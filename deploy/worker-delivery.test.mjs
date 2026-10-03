import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import vm from 'node:vm';
import {fileURLToPath} from 'node:url';
import * as delivery from './worker-delivery.mjs';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const manifest=JSON.parse(await fs.readFile(path.join(root,'deploy/worker-delivery.json'),'utf8'));
const revision='8a0d7eab88e1dd896f7d2e9806879be3c729e899';
const settings=()=>({bindings:[{name:'ADMIN_TOKEN',type:'secret_text'},{name:'AI',type:'ai',project:'<catalog>'},{name:'DB',type:'d1',id:'5f04098c-cb7c-4464-b8ae-e9063392ab70'}],compatibility_date:'2026-05-01',compatibility_flags:['nodejs_compat'],logpush:false,tail_consumers:[]});
const schedules=()=>({schedules:[{cron:'0 */6 * * *',created_on:'old',modified_on:'later'}]});
const clone=value=>JSON.parse(JSON.stringify(value));
const fails=(fn,category)=>assert.throws(fn,error=>error instanceof delivery.DeliveryError&&error.diagnostic.category===category);
test('manifest target, source branch, exact page artifacts and supported pins are fixed',()=>{
  assert.equal(delivery.validateManifest(manifest),manifest);
  for(const mutate of [m=>m.source.branch='main',m=>m.cloudflare.worker='other',m=>m.tooling.wrangler_version='latest',
    m=>m.associated_pages.public_artifacts[0].path='https://other.example/',m=>m.build.archive_paths.push('.env')]) {
    const m=clone(manifest);mutate(m);assert.throws(()=>delivery.validateManifest(m),delivery.DeliveryError);
  }
});
test('modes are exclusive and build-only refuses credentials before access',()=>{
  const args=['--expected-revision',revision,'--wrangler-dist','external/cli.js','--report','external.json'];
  assert.equal(delivery.parseArgs(['--verify-only',...args]).mode,'verify');
  fails(()=>delivery.parseArgs(['--publish','--verify-only',...args]),'multiple-modes');
  fails(()=>delivery.parseArgs(['--build-only',...args,'--cloudflare-token-file','must-not-read']),'build-must-be-credential-free');
  fails(()=>delivery.parseArgs([...args,'--migration']),'unknown-option');
});
test('authoritative fresh master, clean content and exact origin all gate publication',async()=>{
  const fake=values=>async(...args)=>values[args.join(' ')]??'';
  const good={'remote get-url origin':'https://github.com/bergvictor/aimoney.git','ls-remote origin refs/heads/master':revision+'\trefs/heads/master\n','rev-parse HEAD':revision+'\n','status --porcelain=v1 --untracked-files=all':''};
  assert.equal(await delivery.freshRevision(manifest,revision,fake(good)),revision);
  for(const [key,value] of [['remote get-url origin','https://github.com/other/aimoney'],['rev-parse HEAD','b'.repeat(40)],['status --porcelain=v1 --untracked-files=all',' M public/app.js']]) {
    await assert.rejects(delivery.freshRevision(manifest,revision,fake({...good,[key]:value})),delivery.DeliveryError);
  }
  fails(()=>delivery.parseRemoteHead(revision+'\trefs/heads/main'),'remote-ref');
});
test('full revision stamp matches the existing shared shell helper byte contract',async()=>{
  const source=await fs.readFile(path.join(root,'worker/src/rev.js'));
  const stamp=delivery.stampRevision(revision,source);
  assert.equal(stamp.length,224);assert.equal(delivery.sha256(stamp),'4011029f45b1596e3fa114e1c03715aa23280b847155af0f98ae62856b355675');
  const helper=await fs.readFile(path.join(root,'deploy/stamp-worker-rev.sh'),'utf8');
  assert.ok(helper.includes('export const WORKER_REV = "%s"'));assert.ok(helper.includes('"$SHA" > worker/src/rev.js'));
  fails(()=>delivery.stampRevision(revision.slice(0,7),source),'full-revision-required');
  fails(()=>delivery.stampRevision(revision,Buffer.from('unknown')),'stamp-contract-changed');
});
test('provider baseline preserves exact existing AI, D1, secret name, compatibility and cron',()=>{
  const a=delivery.settingsInventory(settings(),schedules(),manifest);
  const b=settings();b.observability={enabled:false};
  const proof=delivery.settingsInventory(b,schedules(),manifest);
  delivery.assertConfiguration(a,proof);
  assert.equal(a.bindings.length,3);assert.deepEqual(a.crons,['0 */6 * * *']);
  assert.equal(JSON.stringify(a).includes('secret value'),false);
});
test('unknown settings, secret/binding drift, revision override and observability enablement fail closed',()=>{
  for(const mutate of [s=>s.unknown_behavior=true,s=>s.logpush=true,s=>s.observability={enabled:true},
    s=>s.observability={enabled:false,head_sampling_rate:0.1},s=>s.bindings[2].id='other',
    s=>s.bindings[1].project='other',s=>s.bindings[0].name='OTHER_SECRET',
    s=>s.bindings.push({name:'WORKER_REV',type:'plain_text',text:'forged'})]) {
    const s=settings();mutate(s);assert.throws(()=>delivery.settingsInventory(s,schedules(),manifest),delivery.DeliveryError);
  }
  fails(()=>delivery.settingsInventory(settings(),{schedules:[{cron:'* * * * *'}]},manifest),'cron-drift');
});
test('configuration digest detects changes while ignoring provider schedule timestamps',()=>{
  const before=delivery.settingsInventory(settings(),schedules(),manifest);
  const after=clone(before);after.configuration_sha256='0'.repeat(64);
  fails(()=>delivery.assertConfiguration(before,after),'changed-during-delivery');
  delivery.assertConfiguration(before,delivery.settingsInventory(settings(),{schedules:[{cron:'0 */6 * * *',modified_on:'new'}]},manifest));
});
test('active UUID requires single100percent traffic and exact full Git annotation',()=>{
  assert.equal(delivery.activeVersion({deployments:[{versions:[{percentage:100,version_id:'version-1'}]}]}),'version-1');
  for(const versions of [[{percentage:50,version_id:'v'}],[{percentage:50,version_id:'a'},{percentage:50,version_id:'b'}]])fails(()=>delivery.activeVersion({deployments:[{versions}]}),'active-traffic');
  delivery.assertAnnotation({metadata:{annotations:{'workers/message':'git:'+revision}}},revision);
  fails(()=>delivery.assertAnnotation({metadata:{annotations:{'workers/message':'git:'+revision.slice(0,7)}}},revision),'source-annotation');
});
test('public root requires full revision and healthy DB without recording last_run',()=>{
  const proof=delivery.publicRootProof({ok:true,agent:'research-v1',rev:revision,last_run:{private:'must-not-log'}},200,revision);
  assert.deepEqual(proof,{ok:true,agent:'research-v1',rev:revision,http_status:200});
  assert.equal(JSON.stringify(proof).includes('must-not-log'),false);
  for(const data of [{ok:true,agent:'research-v1'}, {ok:true,agent:'research-v1',rev:revision.slice(0,7)}, {ok:false,agent:'research-v1',rev:revision}])fails(()=>delivery.publicRootProof(data,200,revision),'runtime-revision');
  fails(()=>delivery.publicRootProof({ok:true,agent:'research-v1',rev:revision},503,revision),'runtime-revision');
});
test('associated Pages rejects old full revision even for a controller-only source commit',()=>{
  assert.deepEqual(delivery.pagesRevisionProof({project:'aimoney',revision},revision),{revision,current_full_revision:true});
  fails(()=>delivery.pagesRevisionProof({project:'aimoney',revision:'b'.repeat(40)},revision),'revision-scope');
  fails(()=>delivery.pagesRevisionProof({project:'aimoney',revision:revision.slice(0,7)},revision),'revision-scope');
});
test('provider reads only whitelisted exact Cloudflare API origin with manual redirects',async()=>{
  const calls=[];const cf=delivery.provider('opaque-fixture',manifest,async(url,options)=>{
    calls.push({url,options});return new Response(JSON.stringify({success:true,result:{value:1}}),{status:200});
  });
  assert.deepEqual(await cf.json('/settings'),{value:1});
  assert.equal(calls[0].url,'https://api.cloudflare.com/client/v4/accounts/97120bae9770152d66a6881976a2a2d4/workers/scripts/aimoney-research/settings');
  assert.equal(calls[0].options.method,'GET');assert.equal(calls[0].options.redirect,'manual');
  await assert.rejects(cf.json('/../other'),error=>error.diagnostic.category==='unexpected-route');
  assert.equal(calls.length,1);
});
test('authenticated redirects, error bodies and network errors are never followed or exposed',async()=>{
  for(const status of [301,302,303,307,308,403]) {
    let count=0;const cf=delivery.provider('private-token',manifest,async()=>{
      count++;return new Response('private-token body',{status,headers:{Location:'https://other.example/private-token'}});
    });
    await assert.rejects(cf.json('/settings'),error=>{
      assert.equal(JSON.stringify(error.diagnostic).includes('private-token'),false);return error.diagnostic.http_status===status;
    });assert.equal(count,1);
  }
  const cf=delivery.provider('private-token',manifest,async()=>{throw Error('private-token network');});
  await assert.rejects(cf.json('/settings'),error=>!error.message.includes('private-token'));
});
test('compiled artifact proof rejects a stale module even when UUID and source annotation match',async()=>{
  const module=Buffer.from('approved compiled module'),result={deployments:[{versions:[{percentage:100,version_id:'active-v'}]}]};
  const cf={json:async route=>route==='/deployments'?result:{metadata:{annotations:{'workers/message':'git:'+revision}}},module:async()=>({module_name:'worker-entry.mjs',text_transport:false,bytes:Buffer.concat([module,Buffer.from(' ')])})};
  await assert.rejects(delivery.verifyRuntime(cf,manifest,revision,{module_sha256:delivery.sha256(module)},()=>{throw Error('must not fetch stale code');}),error=>error.diagnostic.category==='compiled-artifact');
});
test('runtime proof checks exact artifact, fresh full public rev and stable active version',async()=>{
  const module=Buffer.from('approved module'),result={deployments:[{versions:[{percentage:100,version_id:'active-v'}]}]};
  const cf={json:async route=>route==='/deployments'?result:{metadata:{annotations:{'workers/message':'git:'+revision}}},module:async()=>({module_name:'worker-entry.mjs',text_transport:false,bytes:module})};
  const proof=await delivery.verifyRuntime(cf,manifest,revision,{module_sha256:delivery.sha256(module)},async()=>new Response(JSON.stringify({ok:true,agent:'research-v1',rev:revision,last_run:{private:'never log'}}),{status:200}));
  assert.equal(proof.module_sha256,delivery.sha256(module));assert.equal(JSON.stringify(proof).includes('never log'),false);
});
test('Pages proof compares all exact served bytes and exact fresh release revision',async()=>{
  let publicReads=0;
  const fetcher=async url=>{
    publicReads++;
    return new Response(url.pathname==='/release.json'?JSON.stringify({project:'aimoney',revision}):'approved asset',{status:200});
  };
  const proof=await delivery.pagesProof(manifest,revision,fetcher,async()=>Buffer.from('approved asset'));
  assert.equal(proof.artifacts.length,4);assert.equal(publicReads,5);
  await assert.rejects(delivery.pagesProof(manifest,revision,async()=>new Response('changed asset',{status:200}),async()=>Buffer.from('approved asset')),error=>error.diagnostic.category==='artifact-sha256');
});
test('build-only never reaches credentials/provider/publication/runtime checks',async()=>{
  const bad={cf:{json(){throw Error('provider accessed');}},publish(){throw Error('publication accessed');},fresh(){throw Error('remote accessed');}};
  assert.deepEqual(await delivery.deliver({mode:'build'},manifest,revision,{},'',{},bad),{build_complete:true,complete:false});
});
test('verify-only performs no publication and proves unchanged config',async()=>{
  let writes=0;
  const cf={json:async route=>route==='/settings'?settings():schedules()};
  const result=await delivery.deliver({mode:'verify'},manifest,revision,{},'',{},{
    cf,publish:async()=>writes++,fresh:async()=>revision,pages:async()=>({revision}),verify:async()=>({rev:revision})
  });
  assert.equal(result.complete,true);assert.equal(result.published,false);assert.equal(writes,0);
});
test('configuration, Pages and source failure occur before any publication',async()=>{
  for(const phase of ['settings','pages','source']) {
    let writes=0;const cf={json:async route=>{
      if(route==='/settings'){const s=settings();if(phase==='settings')s.logpush=true;return s;}return schedules();
    }};
    await assert.rejects(delivery.deliver({mode:'publish'},manifest,revision,{},'',{},{
      cf,publish:async()=>writes++,fresh:async()=>phase==='source'?'b'.repeat(40):revision,
      pages:async()=>{if(phase==='pages')throw new delivery.DeliveryError('pages','artifact-sha256');return {};},
      verify:async()=>({})
    }),delivery.DeliveryError);assert.equal(writes,0);
  }
});
test('postpublication config drift fails delivery without application/database operations',async()=>{
  let reads=0,writes=0;const cf={json:async route=>{
    if(route==='/settings'){reads++;const s=settings();if(reads===3)s.tail_consumers=['unexpected'];return s;}return schedules();
  }};
  await assert.rejects(delivery.deliver({mode:'publish'},manifest,revision,{},'',{},{
    cf,publish:async()=>writes++,fresh:async()=>revision,pages:async()=>({}),verify:async()=>({})
  }),delivery.DeliveryError);assert.equal(writes,1);
});
function tar(files,type='0') {
  const parts=[];
  for(const [name,body] of files) {
    const bytes=Buffer.from(body),header=Buffer.alloc(512);
    header.write(name,0,100);header.write(bytes.length.toString(8).padStart(11,'0')+'\0',124,12);header.write(type,156,1);
    parts.push(header,bytes,Buffer.alloc((512-bytes.length%512)%512));
  }
  parts.push(Buffer.alloc(1024));return Buffer.concat(parts);
}
test('immutable archive accepts exactly scoped files and rejects missing, duplicate, outside and links',()=>{
  assert.equal(delivery.extractArchive(tar([['allowed',Buffer.from('bytes')]]),['allowed']).get('allowed').toString(),'bytes');
  for(const bytes of [tar([['.env','secret']]),tar([['allowed','a'],['allowed','b']]),tar([['allowed','target']],'2'),tar([])])assert.throws(()=>delivery.extractArchive(bytes,['allowed']),delivery.DeliveryError);
});
test('build uses deterministic source stamp, exact pins and only local dry-run commands',async()=>{
  const temp=await fs.mkdtemp(path.join(os.tmpdir(),'aimoney-unit-build-'));
  try {
    const files=await Promise.all(manifest.build.archive_paths.map(async name=>[name,await fs.readFile(path.join(root,name))]));
    const commands=[],runner=async(executable,args,options)=>{
      commands.push({executable,args,options});
      if(args[args.length-1]==='--version')return executable==='esbuild-fixture'?'0.28.1':'4.131.1';
      if(executable==='esbuild-fixture')await fs.writeFile(path.join(temp,'worker-entry.mjs'),'export const REV="'+revision+'";\n');
      return '';
    };
    const proof=await delivery.build(manifest,revision,{cli:'cli-fixture',esbuild:'esbuild-fixture'},temp,async()=>tar(files),runner);
    assert.equal(proof.stamped_rev_sha256,'4011029f45b1596e3fa114e1c03715aa23280b847155af0f98ae62856b355675');
    const upload=commands.find(c=>c.args.includes('deploy'));assert.ok(upload.args.includes('--dry-run'));assert.ok(upload.args.includes('--no-bundle'));assert.ok(upload.args.includes('--keep-vars'));
    for(const command of commands)assert.ok(!command.args.some(arg=>['execute','migrate','secret','run','pages','trigger'].includes(arg)));
  } finally {assert.equal(path.dirname(path.resolve(temp)),path.resolve(os.tmpdir()));assert.ok(path.basename(temp).startsWith('aimoney-unit-build-'));await fs.rm(temp,{recursive:true,force:true});}
});
test('seven child APIs remain windowless through overloads and inherited options; shim is idempotent',async()=>{
  const source=await fs.readFile(path.join(root,'deploy/worker-windowless.cjs'),'utf8'),calls=[],cp={};
  const names=['spawn','spawnSync','execFile','execFileSync','exec','execSync','fork'];
  for(const name of names)cp[name]=function(...args){calls.push({name,args});return 'fixture-result';};
  let syncs=0;const load=vm.runInNewContext('(function(require,module,__filename,process){'+source+'\n})');
  const environment={NODE_OPTIONS:'--no-warnings',UNCHANGED:'fixture'},module={exports:{}};
  const requireFake=name=>name==='node:child_process'?cp:{syncBuiltinESMExports:()=>syncs++};
  load(requireFake,module,'C:/mock/worker-windowless.cjs',{env:environment});
  const originalWrappers={...cp};load(requireFake,{exports:{}},'C:/mock/worker-windowless.cjs',{env:environment});
  assert.equal(syncs,1);for(const name of names)assert.equal(cp[name],originalWrappers[name]);
  const callback=()=>{};
  for(const name of names) {
    if(['exec','execSync'].includes(name))cp[name]('unused',{windowsHide:false,env:{NODE_OPTIONS:'--no-warnings'}},callback);
    else cp[name]('unused',[],{windowsHide:false,env:{NODE_OPTIONS:'--no-warnings'}},callback);
  }
  cp.execFile('unused',callback);cp.execFile('unused',[],callback);cp.spawn('unused',{cwd:'fixture'});cp.fork('unused',{execArgv:['--no-warnings']});
  for(const call of calls) {
    const index=['exec','execSync'].includes(call.name)?1:Array.isArray(call.args[1])?2:1;
    assert.equal(call.args[index].windowsHide,true);assert.ok(call.args[index].env.NODE_OPTIONS.includes('--no-warnings'));assert.ok(call.args[index].env.NODE_OPTIONS.includes('worker-windowless.cjs'));
  }
  assert.equal(module.exports.windowlessEnv(environment).UNCHANGED,'fixture');
});
test('new delivery files cannot trigger the existing schema-writing GitHub workflow',async()=>{
  const workflow=await fs.readFile(path.join(root,'.github/workflows/deploy-worker.yml'),'utf8');
  assert.ok(workflow.includes('branches: [master]'));assert.ok(workflow.includes('- "worker/**"'));assert.ok(workflow.includes('- "d1/**"'));
  const triggerSection=workflow.slice(workflow.indexOf('on:'),workflow.indexOf('jobs:'));
  assert.equal(triggerSection.includes('deploy/**'),false);assert.equal(triggerSection.includes('worker-delivery'),false);
});

test('native runner forces windowless shell:false even when caller attempts overrides',async()=>{
  let captured;
  const result=await delivery.run('unused',['fixture'],{windowsHide:false,shell:true,env:{NODE_OPTIONS:'--no-warnings'}},(executable,args,options,callback)=>{
    captured={executable,args,options};callback(null,'safe result');
  });
  assert.equal(result,'safe result');assert.equal(captured.options.windowsHide,true);assert.equal(captured.options.shell,false);
  assert.ok(captured.options.env.NODE_OPTIONS.includes('worker-windowless.cjs'));assert.ok(captured.options.env.NODE_OPTIONS.includes('--no-warnings'));
});
test('source/canonical/symlink token references are refused before credential contents are read',async()=>{
  let reads=0;
  const fake={lstat:async()=>({isFile:()=>true,isSymbolicLink:()=>false,size:20}),realpath:async value=>path.resolve(value),readFile:async()=>{reads++;return 'opaque-fixture';}};
  for(const file of [path.join(root,'not-a-token'), 'C:/coding-projects/business-apps/aimoney/not-a-token']) {
    await assert.rejects(delivery.readToken(file,os.tmpdir(),fake),error=>error.diagnostic.category==='source-file-refused');
  }
  await assert.rejects(delivery.readToken('external',{},{...fake,lstat:async()=>({isFile:()=>true,isSymbolicLink:()=>true,size:20})}),error=>error.diagnostic.category==='unsafe-file');
  assert.equal(reads,0);
});
test('provider multipart proof selects only the exact named compiled module',async()=>{
  const code='export default {}; \n',form=new FormData();
  form.append('metadata','private metadata must not be inspected');form.append('worker-entry.mjs',code);
  const cf=delivery.provider('opaque-fixture',manifest,async()=>new Response(form));
  const proof=delivery.compiledModuleProof(await cf.module('worker-entry.mjs'),'worker-entry.mjs',delivery.sha256(Buffer.from(code)));
  assert.equal(proof.module_sha256,delivery.sha256(Buffer.from(code)));
  assert.equal(proof.text_transport_newline_handling,'CRLF-to-LF in named text multipart part only');
  const missing=delivery.provider('opaque-fixture',manifest,async()=>new Response(new FormData()));
  await assert.rejects(missing.module('worker-entry.mjs'),error=>error.diagnostic.category==='module-missing');
});
test('runtime proof refuses active-version movement during capture',async()=>{
  let reads=0;const module=Buffer.from('approved module');
  const cf={json:async route=>route==='/deployments'?{deployments:[{versions:[{percentage:100,version_id:++reads===1?'first':'second'}]}]}:{metadata:{annotations:{'workers/message':'git:'+revision}}},module:async()=>({module_name:'worker-entry.mjs',text_transport:false,bytes:module})};
  await assert.rejects(delivery.verifyRuntime(cf,manifest,revision,{module_sha256:delivery.sha256(module)},async()=>new Response(JSON.stringify({ok:true,agent:'research-v1',rev:revision}))),error=>error.diagnostic.category==='version-changed');
});
test('archive configuration tampering fails before invoking any compiler or uploader',async()=>{
  const temp=await fs.mkdtemp(path.join(os.tmpdir(),'aimoney-unit-build-'));
  try {
    const files=await Promise.all(manifest.build.archive_paths.map(async name=>[name,await fs.readFile(path.join(root,name))]));
    files.find(([name])=>name==='worker/wrangler.toml')[1]=Buffer.from('name="other"\n');
    let children=0;
    await assert.rejects(delivery.build(manifest,revision,{cli:'unused',esbuild:'unused'},temp,async()=>tar(files),async()=>children++),error=>error.diagnostic.category==='source-config-scope');
    assert.equal(children,0);
  } finally {assert.equal(path.dirname(path.resolve(temp)),path.resolve(os.tmpdir()));assert.ok(path.basename(temp).startsWith('aimoney-unit-build-'));await fs.rm(temp,{recursive:true,force:true});}
});

test('module fingerprint normalizes only multipart line endings and preserves every other byte',()=>{
  assert.equal(delivery.normalizeModule(Buffer.from('const x=1;\r\n')).toString(),'const x=1;\n');
  assert.equal(delivery.normalizeModule(Buffer.from('const x=1; \n//# sourceMappingURL=keep.map\n')).toString(),'const x=1; \n//# sourceMappingURL=keep.map\n');
  assert.notEqual(delivery.sha256(delivery.normalizeModule(Buffer.from('const x=1;\n'))),delivery.sha256(delivery.normalizeModule(Buffer.from('const x=1;\n\n'))));
  fails(()=>delivery.normalizeModule(Buffer.from([0xff])),'module-encoding');
});

test('only mismatched named text parts may use CRLF fallback; binary and substantive differences reject',()=>{
  const exact=Buffer.from('const x=1;\n'),expected=delivery.sha256(exact);
  const part=(bytes,text_transport=true,module_name='worker-entry.mjs')=>({bytes:Buffer.from(bytes),text_transport,module_name});
  const direct=delivery.compiledModuleProof(part(exact),'worker-entry.mjs',expected);
  assert.equal(direct.text_transport_newline_handling,'unchanged');assert.equal(direct.module_wire_sha256,expected);
  const fallback=delivery.compiledModuleProof(part('const x=1;\r\n'),'worker-entry.mjs',expected);
  assert.equal(fallback.module_sha256,expected);assert.notEqual(fallback.module_wire_sha256,expected);
  for(const candidate of [part('const x=1;\r\n',false),part('const x=1;\r'),part('const x=2;\r\n'),
      part('const x=1; \r\n'),part('const x=1;\r\n//# sourceMappingURL=extra\r\n'),part(exact,true,'other.mjs')]) {
    assert.throws(()=>delivery.compiledModuleProof(candidate,'worker-entry.mjs',expected),delivery.DeliveryError);
  }
});

test('associated Pages is reverified after publication and stale postdelivery bytes fail completion',async()=>{
  let pages=0,writes=0;const cf={json:async route=>route==='/settings'?settings():schedules()};
  await assert.rejects(delivery.deliver({mode:'publish'},manifest,revision,{},'',{},{
    cf,publish:async()=>writes++,fresh:async()=>revision,verify:async()=>({rev:revision}),
    pages:async()=>{if(++pages===2)throw new delivery.DeliveryError('pages','artifact-sha256');return {revision};}
  }),error=>error.diagnostic.category==='artifact-sha256');
  assert.equal(pages,2);assert.equal(writes,1);
});

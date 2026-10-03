import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import {execFile} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import windowless from './worker-windowless.cjs';
const {windowlessEnv} = windowless;
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MANIFEST_PATH = 'deploy/worker-delivery.json';
const DELIVERY_PATHS = ['deploy/worker-delivery.mjs','deploy/worker-windowless.cjs','deploy/worker-delivery.test.mjs','deploy/worker-delivery.json'];
const ARCHIVE_PATHS = ['worker/src/index.js','worker/src/lib.js','worker/src/rev.js','worker/wrangler.toml','deploy/stamp-worker-rev.sh','package.json','package-lock.json',MANIFEST_PATH,...DELIVERY_PATHS.slice(0,3)];
const PINNED_SETTINGS = {compatibility_date:'2026-05-01',compatibility_flags:['nodejs_compat'],usage_model:'standard',placement:{},logpush:false,tags:[],tail_consumers:[],streaming_tail_consumers:[],limits:{},cache_options:{},observability:{enabled:false}};
const ACCOUNT = '97120bae9770152d66a6881976a2a2d4';
const WORKER = 'aimoney-research';
const DATABASE = '5f04098c-cb7c-4464-b8ae-e9063392ab70';
const SHA = /^[a-f0-9]{40}$/;
export const sha256 = value => crypto.createHash('sha256').update(value).digest('hex');
export function normalizeModule(bytes) {
  const raw=Buffer.from(bytes),text=raw.toString('utf8');
  if(!Buffer.from(text,'utf8').equals(raw))fail('provider','module-encoding');
  if(text.replaceAll('\r\n','').includes('\r'))fail('provider','module-newline');
  return Buffer.from(text.replaceAll('\r\n','\n'),'utf8');
}
const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key,canonical(value[key])])) : value;
const same = (a,b) => JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
export class DeliveryError extends Error {
  constructor(phase,category,status=null) { super(phase+': '+category);this.diagnostic={phase,category,http_status:Number.isInteger(status)?status:null}; }
}
const fail = (phase,category,status) => {throw new DeliveryError(phase,category,status);};
export function validateManifest(m) {
  if(m?.schema_version!==1 || m.executor_host!=='MAIN' || m.source?.repo!=='bergvictor/aimoney' || m.source.remote!=='origin' || m.source.branch!=='master') fail('source','manifest-authority');
  if(m.cloudflare?.account_id!==ACCOUNT || m.cloudflare.worker!==WORKER || m.cloudflare.public_url!=='https://aimoney-research.levitinvlad.workers.dev' || m.cloudflare.traffic_percent!==100) fail('target','manifest-target');
  if(!same(m.cloudflare.settings_policy?.normalized,PINNED_SETTINGS) || !same(m.cloudflare.crons,['0 */6 * * *']) || !same(m.build?.archive_paths,ARCHIVE_PATHS)) fail('configuration','manifest-policy');
  if(m.tooling?.wrangler_version!=='4.131.1'||m.tooling.esbuild_version!=='0.28.1'||m.build.entry!=='worker-entry.mjs') fail('build','manifest-tooling');
  if(m.verification?.path!=='/' || m.verification.status!==200 || m.verification.revision_field!=='rev' || m.verification.agent!=='research-v1') fail('public','manifest-contract');
  const pages=[{source:'public/index.html',path:'/'},{source:'public/app.js',path:'/app.js'},{source:'public/favicon.svg',path:'/favicon.svg'},{source:'public/styles.css',path:'/styles.css'}];
  if(m.associated_pages?.url!=='https://aimoney.pages.dev'||m.associated_pages.revision_path!=='/release.json'||!same(m.associated_pages.public_artifacts,pages)) fail('pages','manifest-scope');
  if(m.build.source_config_sha256!=='53a297baacb3f60fa59658fe9474c23e78673f1ad92685331e2597509cb882ef'||m.build.stamp_helper_sha256!=='52c1ad18be79882d061a91a54ac564c06bc0d3d74d9c123e459f60e95721fc7d')fail('build','application-config-scope');
  return m;
}
export function parseArgs(argv) {
  const options={mode:'build'};let mode=false;
  for(let i=0;i<argv.length;i++) {
    const arg=argv[i];
    if(['--build-only','--publish','--verify-only'].includes(arg)) {
      if(mode) fail('arguments','multiple-modes');mode=true;
      options.mode=arg==='--publish'?'publish':arg==='--verify-only'?'verify':'build';
    } else if(['--wrangler-dist','--cloudflare-token-file','--expected-revision','--report'].includes(arg)) {
      if(!argv[i+1]||argv[i+1].startsWith('--'))fail('arguments','missing-value');
      options[arg.slice(2)]=argv[++i];
    } else if(arg==='--help')options.help=true;else fail('arguments','unknown-option');
  }
  if(!options.help && (!SHA.test(options['expected-revision']||'')||!options['wrangler-dist']||!options.report))fail('arguments','required-input');
  if(options.mode==='build'&&options['cloudflare-token-file'])fail('arguments','build-must-be-credential-free');
  return options;
}
export function run(executable,parameters,options={},execute=execFile) {
  return new Promise((resolve,reject)=>execute(executable,parameters,{
    cwd:ROOT,encoding:'utf8',timeout:60000,maxBuffer:8*1024*1024,...options,
    env:windowlessEnv(options.env||process.env),windowsHide:true,shell:false
  },(error,stdout)=>error?reject(new DeliveryError('process','child-failed')):resolve(stdout)));
}
const git = (...parameters) => run('C:/Program Files/Git/cmd/git.exe',['-c','core.filemode=false','-c','credential.interactive=false',...parameters]);
export function parseRemoteHead(text) {
  const rows=text.trim().split(/\r?\n/);
  if(rows.length!==1||!/^([a-f0-9]{40})\s+refs\/heads\/master$/.test(rows[0]))fail('source','remote-ref');
  return rows[0].slice(0,40);
}
export async function freshRevision(m,expected,gitFn=git) {
  const remote=(await gitFn('remote','get-url','origin')).trim().replace(/\.git$/,'');
  if(!['https://github.com/'+m.source.repo,'git@github.com:'+m.source.repo].includes(remote))fail('source','origin-mismatch');
  const fresh=parseRemoteHead(await gitFn('ls-remote','origin','refs/heads/master'));
  if(fresh!==expected||(await gitFn('rev-parse','HEAD')).trim()!==fresh)fail('source','stale-source');
  if((await gitFn('status','--porcelain=v1','--untracked-files=all')).trim())fail('source','dirty-source');
  return fresh;
}
export function extractArchive(bytes,expected=ARCHIVE_PATHS) {
  const files=new Map();let offset=0;
  while(offset+512<=bytes.length) {
    const h=bytes.subarray(offset,offset+512);if(h.every(v=>v===0))break;
    const text=(start,length)=>h.subarray(start,start+length).toString('utf8').split('\0')[0];
    const name=text(0,100),prefix=text(345,155),full=prefix?prefix+'/'+name:name;
    const sizeText=text(124,12).trim();if(!/^[0-7]+$/.test(sizeText))fail('archive','invalid-size');
    const size=parseInt(sizeText,8),type=text(156,1);offset+=512;
    if(size>2*1024*1024||offset+size>bytes.length)fail('archive','member-bound');
    if(type==='0'||type==='') {
      if(!expected.includes(full)||files.has(full))fail('archive','unexpected-member');
      files.set(full,Buffer.from(bytes.subarray(offset,offset+size)));
    } else if(!['5','g','x'].includes(type))fail('archive','unsupported-member');
    offset+=Math.ceil(size/512)*512;
  }
  if(files.size!==expected.length)fail('archive','missing-member');
  return files;
}
export function stampRevision(revision,source) {
  if(!SHA.test(revision))fail('build','full-revision-required');
  const committed='// Deploy-stamped worker revision. deploy/stamp-worker-rev.sh rewrites this\n// file on every deploy; the committed "unknown" is the wrangler-dev default.\nexport const WORKER_REV = "unknown";\n';
  if(source.toString('utf8')!==committed)fail('build','stamp-contract-changed');
  return Buffer.from(committed.replace('export const WORKER_REV = "unknown";','export const WORKER_REV = "'+revision+'";'),'utf8');
}
export function settingsInventory(settings,schedules,m) {
  if(!settings||typeof settings!=='object'||Array.isArray(settings))fail('configuration','settings-shape');
  const known=new Set([...Object.keys(PINNED_SETTINGS),'bindings','annotations']);
  if(Object.keys(settings).some(key=>!known.has(key)))fail('configuration','unknown-setting');
  const normalized={};
  for(const [key,value] of Object.entries(PINNED_SETTINGS))normalized[key]=settings[key]===undefined?value:settings[key];
  if(!same(normalized,m.cloudflare.settings_policy.normalized))fail('configuration','settings-drift');
  const rows=settings.bindings;
  if(Array.isArray(rows)&&rows.some(b=>b.name==='WORKER_REV'))fail('configuration','revision-override');
  if(!Array.isArray(rows)||rows.length!==3||new Set(rows.map(b=>b.name)).size!==3)fail('configuration','bindings-drift');
  const db=rows.find(b=>b.name==='DB'),ai=rows.find(b=>b.name==='AI'),secret=rows.find(b=>b.name==='ADMIN_TOKEN');
  if(db?.type!=='d1'||(db.id??db.database_id)!==DATABASE||db.database_id&&db.database_id!==DATABASE)fail('configuration','database-identity');
  if(ai?.type!=='ai'||ai.project&&ai.project!=='<catalog>'||secret?.type!=='secret_text')fail('configuration','bindings-drift');
  if(rows.some(b=>b.name==='WORKER_REV'))fail('configuration','revision-override');
  const crons=(schedules?.schedules||[]).map(s=>s.cron).sort();
  if(!same(crons,m.cloudflare.crons))fail('configuration','cron-drift');
  const annotations=settings.annotations??{};
  if(typeof annotations!=='object'||Array.isArray(annotations)||Object.keys(annotations).some(k=>!['workers/message','workers/triggered_by'].includes(k)))fail('configuration','annotation-drift');
  const bindings=[{name:'ADMIN_TOKEN',type:'secret_text'},{name:'AI',type:'ai',project:'<catalog>'},{name:'DB',type:'d1',database_id:DATABASE}];
  const inventory={settings:canonical(normalized),bindings,crons};
  return {...inventory,configuration_sha256:sha256(JSON.stringify(canonical(inventory)))};
}
export function assertConfiguration(before,after) {
  if(before.configuration_sha256!==after.configuration_sha256)fail('configuration','changed-during-delivery');
}
export function activeVersion(result) {
  const rows=result?.deployments?.[0]?.versions;
  const active=Array.isArray(rows)?rows.filter(v=>Number(v.percentage)>0):[];
  if(active.length!==1||Number(active[0].percentage)!==100||!/^[a-zA-Z0-9-]+$/.test(active[0].version_id||''))fail('provider','active-traffic');
  return active[0].version_id;
}
export function assertAnnotation(version,revision) {
  if((version?.metadata?.annotations||version?.annotations)?.['workers/message']!=='git:'+revision)fail('provider','source-annotation');
}
export function publicRootProof(data,status,revision) {
  if(status!==200||!data||data.ok!==true||data.agent!=='research-v1'||data.rev!==revision||!SHA.test(data.rev||''))fail('public','runtime-revision',status);
  return {ok:true,agent:'research-v1',rev:revision,http_status:status};
}
export function pagesRevisionProof(data,revision) {
  if(data?.project!=='aimoney'||data.revision!==revision||!SHA.test(data.revision||''))fail('pages','revision-scope');
  return {revision:data.revision,current_full_revision:true};
}
export async function bounded(response,max=2*1024*1024) {
  const reader=response.body?.getReader();if(!reader)fail('response','missing-body');
  const parts=[];let total=0;
  try {for(;;){const {done,value}=await reader.read();if(done)break;total+=value.length;if(total>max)fail('response','body-bound');parts.push(Buffer.from(value));}}
  finally {await reader.cancel().catch(()=>{});}
  return Buffer.concat(parts);
}
export function provider(token,m,fetchFn=fetch) {
  const base='https://api.cloudflare.com/client/v4/accounts/'+ACCOUNT+'/workers/scripts/'+WORKER;
  const read=async suffix=>{
    if(!['','/settings','/schedules','/deployments'].includes(suffix)&&!/^\/versions\/[a-zA-Z0-9-]+$/.test(suffix))fail('provider','unexpected-route');
    let response;
    try {response=await fetchFn(base+suffix,{method:'GET',redirect:'manual',headers:{Authorization:'Bearer '+token},signal:AbortSignal.timeout(15000)});}
    catch {fail('provider','read-failed');}
    if(!response.ok||response.status>=300){await response.body?.cancel();fail('provider','http-status',response.status);}
    return response;
  };
  return {json:async suffix=>{
    let data;try {data=JSON.parse((await bounded(await read(suffix))).toString('utf8'));}
    catch(error){if(error instanceof DeliveryError)throw error;fail('provider','invalid-json');}
    if(data?.success!==true)fail('provider','read-rejected');return data.result;
  },module:async name=>{
    const response=await read(''),type=response.headers.get('content-type')||'';
    if(!type.includes('multipart/form-data'))fail('provider','module-content-type');
    let form;try{form=await new Response(await bounded(response),{headers:{'content-type':type}}).formData();}catch{fail('provider','module-multipart');}
    const part=form.get(name);if(part===null)fail('provider','module-missing');
    const bytes=typeof part==='string'?Buffer.from(part,'utf8'):Buffer.from(await part.arrayBuffer());
    if(bytes.length>512*1024)fail('provider','module-bound');return {module_name:name,bytes,text_transport:typeof part==='string'};
  }};
}
export function compiledModuleProof(part,name,expected) {
  if(!part||part.module_name!==name||!Buffer.isBuffer(part.bytes)||typeof part.text_transport!=='boolean')fail('provider','module-identity');
  const wire=sha256(part.bytes);
  if(wire===expected)return {module_sha256:expected,module_wire_sha256:wire,text_transport_newline_handling:'unchanged'};
  if(!part.text_transport||!part.bytes.includes(Buffer.from('\r\n'))||sha256(normalizeModule(part.bytes))!==expected)fail('provider','compiled-artifact');
  return {module_sha256:expected,module_wire_sha256:wire,text_transport_newline_handling:'CRLF-to-LF in named text multipart part only'};
}
export async function configurationProof(cf,m) {
  const [settings,schedules]=await Promise.all([cf.json('/settings'),cf.json('/schedules')]);
  return settingsInventory(settings,schedules,m);
}
async function publicFetch(url,fetchFn=fetch) {
  let response;try{response=await fetchFn(url,{method:'GET',redirect:'manual',headers:{'Cache-Control':'no-cache','Accept-Encoding':'identity','User-Agent':'AIMoney-Worker-Delivery/1'},signal:AbortSignal.timeout(15000)});}catch{fail('public','request-failed');}
  if(response.status!==200){await response.body?.cancel();fail('public','http-status',response.status);}
  return response;
}
export async function verifyRuntime(cf,m,revision,build,fetchFn=fetch) {
  const id=activeVersion(await cf.json('/deployments'));assertAnnotation(await cf.json('/versions/'+id),revision);
  const moduleProof=compiledModuleProof(await cf.module(m.build.entry),m.build.entry,build.module_sha256);
  const target=new URL(m.cloudflare.public_url+'/');target.searchParams.set('verify',revision+'-'+Date.now());
  const response=await publicFetch(target,fetchFn);let data;
  try{data=JSON.parse((await bounded(response,256*1024)).toString('utf8'));}catch{fail('public','invalid-json');}
  const root=publicRootProof(data,response.status,revision);
  if(activeVersion(await cf.json('/deployments'))!==id)fail('provider','version-changed');
  return {active_version_id:id,traffic_percent:100,annotation:'git:'+revision,...moduleProof,public:root};
}
export async function pagesProof(m,revision,fetchFn=fetch,gitFn=git) {
  const artifacts=[];
  for(const artifact of m.associated_pages.public_artifacts) {
    const expected=await gitFn('show',revision+':'+artifact.source);
    const target=new URL(artifact.path,m.associated_pages.url);target.searchParams.set('verify',revision+'-'+Date.now());
    const hash=sha256(await bounded(await publicFetch(target,fetchFn)));
    if(hash!==sha256(Buffer.from(expected)))fail('pages','artifact-sha256');
    artifacts.push({path:artifact.path,sha256:hash});
  }
  const target=new URL(m.associated_pages.revision_path,m.associated_pages.url);target.searchParams.set('verify',revision+'-'+Date.now());
  let data;try{data=JSON.parse((await bounded(await publicFetch(target,fetchFn))).toString('utf8'));}catch{fail('pages','invalid-json');}
  return {...pagesRevisionProof(data,revision),artifacts};
}
async function tooling(file,m) {
  const cli=await fs.realpath(path.resolve(file));
  if(path.basename(cli)!=='cli.js'||path.basename(path.dirname(cli))!=='wrangler-dist')fail('build','direct-cli-required');
  const pkg=path.dirname(path.dirname(cli)),modules=path.dirname(pkg);
  if(JSON.parse(await fs.readFile(path.join(pkg,'package.json'),'utf8')).version!==m.tooling.wrangler_version||JSON.parse(await fs.readFile(path.join(modules,'esbuild/package.json'),'utf8')).version!==m.tooling.esbuild_version)fail('build','tool-pin');
  const esbuild=path.join(modules,'@esbuild/win32-x64/esbuild.exe');
  return {cli,esbuild};
}
function buildEnvironment() {
  const env={...process.env,WRANGLER_SEND_METRICS:'false'};
  for(const key of Object.keys(env))if(/^(CLOUDFLARE|CF)_(API_TOKEN|API_KEY|EMAIL|ACCOUNT_ID)$/i.test(key))delete env[key];
  return windowlessEnv(env);
}
export async function build(m,revision,tools,temp,gitFn=git,runFn=run) {
  const archive=await gitFn('archive','--format=tar',revision,'--',...m.build.archive_paths);
  // Binary git archives use a dedicated runner in main; injected tests return Buffers.
  const files=extractArchive(Buffer.from(archive));
  if(!same(validateManifest(JSON.parse(files.get(MANIFEST_PATH).toString('utf8'))),m))fail('archive','manifest-mismatch');
  for(const rel of m.build.archive_paths) {const destination=path.join(temp,rel);await fs.mkdir(path.dirname(destination),{recursive:true});await fs.writeFile(destination,files.get(rel));}
  if(sha256(files.get('worker/wrangler.toml'))!==m.build.source_config_sha256||sha256(files.get('deploy/stamp-worker-rev.sh'))!==m.build.stamp_helper_sha256)fail('build','source-config-scope');
  const toml=files.get('worker/wrangler.toml').toString('utf8');
  if(!/^name\s*=\s*"aimoney-research"$/m.test(toml)||!/^main\s*=\s*"src\/index.js"$/m.test(toml)||!/^compatibility_date\s*=\s*"2026-05-01"$/m.test(toml)||!toml.includes('crons = ["0 */6 * * *"]')||!toml.includes('database_id = "'+DATABASE+'"')||!toml.includes('binding = "AI"'))fail('build','source-config');
  const lock=JSON.parse(files.get('package-lock.json').toString('utf8'));
  if(lock.packages?.['node_modules/wrangler']?.version!=='4.131.1'||lock.packages?.['node_modules/esbuild']?.version!=='0.28.1')fail('build','lock-pin');
  const rev=stampRevision(revision,files.get('worker/src/rev.js'));
  await fs.writeFile(path.join(temp,'worker/src/rev.js'),rev);
  const env=buildEnvironment(),preload=path.join(temp,'deploy/worker-windowless.cjs');
  const wranglerVersion=(await runFn(process.execPath,['--require',preload,tools.cli,'--version'],{cwd:temp,env})).trim();
  if(!/^4\.131\.1(?:\s|$)/.test(wranglerVersion))fail('build','wrangler-runtime-pin');
  if((await runFn(tools.esbuild,['--version'],{cwd:temp,env})).trim()!=='0.28.1')fail('build','esbuild-runtime-pin');
  await runFn(tools.esbuild,['worker/src/index.js','--bundle','--format=esm','--platform=neutral','--target=es2022','--keep-names','--outfile='+m.build.entry],{cwd:temp,env});
  const module=await fs.readFile(path.join(temp,m.build.entry));
  if(!module.includes(Buffer.from(revision)))fail('build','compiled-revision');
  await runFn(process.execPath,['--require',preload,tools.cli,'deploy',m.build.entry,'--config','worker/wrangler.toml','--dry-run','--outdir','wrangler-dry','--no-bundle','--keep-vars','--message','git:'+revision],{cwd:temp,env,timeout:120000});
  return {revision,module_sha256:sha256(module),source_archive_sha256:sha256(archive),stamped_rev_sha256:sha256(rev),source_hashes:Object.fromEntries([...files].map(([name,bytes])=>[name,sha256(bytes)]))};
}
export async function readToken(file,temp,fsApi=fs) {
  if(!file)fail('credentials','external-file-required');
  const absolute=path.resolve(file),stat=await fsApi.lstat(absolute);
  if(!stat.isFile()||stat.isSymbolicLink()||stat.size>8192)fail('credentials','unsafe-file');
  const real=await fsApi.realpath(absolute);
  for(const forbidden of [await fsApi.realpath(ROOT),await fsApi.realpath('C:/coding-projects/business-apps/aimoney'),temp]) {const rel=path.relative(forbidden,real);if(rel===''||(!rel.startsWith('..'+path.sep)&&rel!=='..'&&!path.isAbsolute(rel)))fail('credentials','source-file-refused');}
  const token=(await fsApi.readFile(real,'utf8')).trim();if(!token||/\s/.test(token))fail('credentials','opaque-token-required');return token;
}
export async function deliver(options,m,revision,tools,temp,buildProof,dependencies={}) {
  const fresh=dependencies.fresh||(()=>freshRevision(m,revision)),publish=dependencies.publish||(()=>fail('publication','publisher-missing'));
  const cf=dependencies.cf,pages=dependencies.pages||(()=>pagesProof(m,revision)),verify=dependencies.verify||(()=>verifyRuntime(cf,m,revision,buildProof));
  if(options.mode==='build')return {build_complete:true,complete:false};
  if(!cf)fail('provider','client-required');
  const before=await configurationProof(cf,m),associated=await pages();
  if(await fresh()!==revision)fail('source','advanced-before-publication');
  assertConfiguration(before,await configurationProof(cf,m));
  if(options.mode==='publish')await publish();
  let live,lastError;
  for(let attempt=0;attempt<(options.mode==='publish'?6:1);attempt++) {
    try{live=await verify();lastError=null;break;}catch(error){lastError=error;if(options.mode==='publish'&&attempt<5)await new Promise(resolve=>setTimeout(resolve,1000));}
  }
  if(lastError)throw lastError;
  const after=await configurationProof(cf,m);assertConfiguration(before,after);
  const afterPages=await pages();
  if(await fresh()!==revision)fail('source','advanced-during-verification');
  return {complete:true,published:options.mode==='publish',configuration_sha256:before.configuration_sha256,bindings:before.bindings,crons:before.crons,live,associated_pages:afterPages};
}
export async function main(argv=process.argv.slice(2)) {
  const options=parseArgs(argv);
  if(options.help){console.log('Windowless MAIN: node deploy/worker-delivery.mjs --build-only|--publish|--verify-only --expected-revision FULL_SHA --wrangler-dist EXTERNAL/wrangler-dist/cli.js --report EXTERNAL_REPORT [--cloudflare-token-file EXTERNAL_TOKEN]');return;}
  if(process.platform!=='win32'||os.hostname().toUpperCase()!=='VLADDYDADDY')fail('placement','MAIN-required');
  const reportPath=path.resolve(options.report),reportRelative=path.relative(ROOT,reportPath);
  if(reportRelative===''||(!reportRelative.startsWith('..'+path.sep)&&reportRelative!=='..'&&!path.isAbsolute(reportRelative)))fail('report','external-report-required');
  if(options['cloudflare-token-file']&&path.resolve(options['cloudflare-token-file'])===reportPath)fail('report','credential-output-refused');
  try{if((await fs.lstat(reportPath)).isSymbolicLink())fail('report','symlink-refused');}catch(error){if(error.code!=='ENOENT')throw error;}
  const report={mode:options.mode,started_at:new Date().toISOString(),complete:false};
  let temp,lock;
  const lockPath=path.join(os.tmpdir(),'aimoney-worker-delivery-'+ACCOUNT+'.lock');
  try {
    lock=await fs.open(lockPath,'wx');
    const m=validateManifest(JSON.parse(await fs.readFile(path.join(ROOT,MANIFEST_PATH),'utf8')));
    const revision=await freshRevision(m,options['expected-revision']);report.revision=revision;
    const tools=await tooling(options['wrangler-dist'],m);temp=await fs.mkdtemp(path.join(os.tmpdir(),'aimoney-worker-build-'));
    const binaryGit=async(...parameters)=>parameters[0]==='archive'?run('C:/Program Files/Git/cmd/git.exe',['-c','core.filemode=false',...parameters],{encoding:null}):git(...parameters);
    report.build=await build(m,revision,tools,temp,binaryGit);
    if(options.mode==='build')Object.assign(report,{build_complete:true});
    else {
      const token=await readToken(options['cloudflare-token-file'],temp),cf=provider(token,m);
      const publish=async()=>{report.publication_started=true;await run(process.execPath,['--require',path.join(temp,'deploy/worker-windowless.cjs'),tools.cli,'deploy',m.build.entry,'--config','worker/wrangler.toml','--no-bundle','--keep-vars','--message','git:'+revision],{cwd:temp,env:windowlessEnv({...process.env,CLOUDFLARE_API_TOKEN:token,CLOUDFLARE_ACCOUNT_ID:ACCOUNT,WRANGLER_SEND_METRICS:'false'}),timeout:120000});report.publication_acknowledged=true;};
      Object.assign(report,await deliver(options,m,revision,tools,temp,report.build,{cf,publish}));
    }
  } catch(error) {report.diagnostic=error instanceof DeliveryError?error.diagnostic:{phase:'controller',category:'unexpected-error',http_status:null};}
  finally {
    report.finished_at=new Date().toISOString();
    if(lock){await lock.close();await fs.unlink(lockPath);}
    if(temp){const resolved=path.resolve(temp);if(path.dirname(resolved)!==path.resolve(os.tmpdir())||!path.basename(resolved).startsWith('aimoney-worker-build-'))fail('cleanup','unsafe-path');await fs.rm(resolved,{recursive:true,force:true});}
    await fs.writeFile(reportPath,JSON.stringify(report,null,2)+'\n');
  }
  console.log(JSON.stringify(report));
  if(report.diagnostic)process.exitCode=1;
  return report;
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))main().catch(error=>{
  console.error(JSON.stringify({complete:false,diagnostic:error instanceof DeliveryError?error.diagnostic:{phase:'controller',category:'unexpected-error',http_status:null}}));process.exitCode=1;
});

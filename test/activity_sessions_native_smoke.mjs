/** Opt-in installed-stock SDK smoke with a deterministic LOCAL stream adapter.
 * PI_PROOF_NPM_ROOT=/absolute/node_modules node test/activity_sessions_native_smoke.mjs
 * No real model/provider calls, installs, credentials or service changes. The
 * scripted adapter exercises genuine SDK response/tool events, not an LLM.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { installActivityBridge } from '../tool/activity-bridge.mjs';
import { writeAtomicSnapshot } from '../tool/activity-metadata.mjs';

const npmRoot = process.env.PI_PROOF_NPM_ROOT;
assert.ok(npmRoot, 'Supply an explicitly trusted installed npm root');
if (!process.argv.includes('--isolated')) {
  const root = mkdtempSync(join(tmpdir(), 'limilink-session-native-'));
  const guard = join(root, 'network-guard.mjs');
  writeFileSync(guard, `import {Socket} from 'node:net';import {appendFileSync} from 'node:fs';const deny=()=>{appendFileSync(${JSON.stringify(join(root, 'network-attempts'))},'blocked\\n');throw new Error('Network forbidden in smoke');};globalThis.fetch=deny;Socket.prototype.connect=deny;`);
  const child = spawn(process.execPath, [process.argv[1], '--isolated'], { env: {
    PATH: process.env.PATH, HOME: root, TMPDIR: root, PI_CODING_AGENT_DIR: join(root, 'agent'),
    PI_PROOF_NPM_ROOT: npmRoot, PI_PROOF_ROOT: root, NODE_OPTIONS: `--import=${guard}`, NO_COLOR: '1', CI: '1',
  }, stdio: 'inherit' });
  const timeout = setTimeout(() => child.kill('SIGTERM'), 45000);
  const [code] = await once(child, 'exit'); clearTimeout(timeout); process.exitCode = code ?? 1;
} else {
  const root = process.env.PI_PROOF_ROOT, agentDir = join(root, 'agent'), sessions = join(root, 'sessions');
  for (const dir of [agentDir, sessions, join(agentDir, 'agents'), join(agentDir, 'extensions', 'subagent')]) mkdirSync(dir, { recursive: true });
  symlinkSync(npmRoot, join(root, 'node_modules'), 'dir');
  const bootstrap = join(root, 'public-imports.mjs');
  writeFileSync(bootstrap, "export * as sdk from '@earendil-works/pi-coding-agent';export {registerRequiredChildExtensions} from 'pi-subagents/required-child-extensions';");
  const { sdk, registerRequiredChildExtensions } = await import(pathToFileURL(bootstrap).href);
  const require = createRequire(join(npmRoot, 'package.json'));
  assert.equal(JSON.parse(readFileSync(join(npmRoot, 'pi-subagents', 'package.json'))).version, '0.78.0');
  writeFileSync(join(agentDir, 'settings.json'), JSON.stringify({ compaction: { enabled: false }, retry: { enabled: false } }));
  writeFileSync(join(agentDir, 'extensions', 'subagent', 'config.json'), JSON.stringify({ defaultSubagentContext: 'fresh', maxSubagentDepth: 2, completionBatch: { enabled: false } }));
  writeFileSync(join(root, 'private-read-fixture.txt'), 'PRIVATE_BODY_NEVER_IN_ACTIVITY');
  const scripted = join(root, 'scripted-fixture.mjs');
  writeFileSync(scripted, `import {Type,createAssistantMessageEventStream} from '@earendil-works/pi-ai';import {appendFileSync} from 'node:fs';
export default function(pi){
 let child=false;
 pi.on('session_start',(_event,ctx)=>{child=typeof ctx.sessionManager.getHeader()?.parentSession==='string';});
 // Parent completion wakes are consumed. Child prompts use only the local script.
 pi.on('input',()=>child?undefined:{action:'handled'});
 pi.registerProvider('observer-proof',{api:'observer-scripted',apiKey:'fixture-only',baseUrl:'http://127.0.0.1:1',
  models:['worker','parent'].map(id=>({id,name:id,reasoning:false,input:['text'],cost:{input:0,output:0,cacheRead:0,cacheWrite:0},contextWindow:8192,maxTokens:1024})),
  streamSimple(model,context){
   appendFileSync(${JSON.stringify(join(root, 'scripted-streams'))},'scripted\\n');
   const stream=createAssistantMessageEventStream();
   const hasAssistant=context.messages.some(message=>message.role==='assistant');
   const calls=hasAssistant?[]:[{type:'toolCall',id:'scripted-outer',name:'proof_outer',arguments:{}}];
   if(!hasAssistant&&model.id==='parent')calls.push({type:'toolCall',id:'scripted-delegate',name:'subagent',arguments:{agent:'observer-leaf',task:'Synthetic nested fixture',context:'fresh',async:true,acceptance:{level:'none',reason:'Scripted SDK fixture'}}});
   const message={role:'assistant',api:model.api,provider:model.provider,model:model.id,timestamp:Date.now(),content:calls.length?calls:[{type:'text',text:'Synthetic fixture complete'}],stopReason:calls.length?'toolUse':'stop',usage:{input:12,output:7,cacheRead:18,cacheWrite:0,totalTokens:37,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}}};
   queueMicrotask(()=>{stream.push({type:'start',partial:message});for(let i=0;i<calls.length;i++){stream.push({type:'toolcall_start',contentIndex:i,partial:message});stream.push({type:'toolcall_end',contentIndex:i,toolCall:calls[i],partial:message});}stream.push({type:'done',reason:message.stopReason,message});stream.end();});return stream;
  }});
 pi.registerTool({name:'proof_outer',label:'proof',description:'Local synthetic nested read',parameters:Type.Object({}),execute:async(_id,_args,_signal,_update,ctx)=>{await ctx.executeTool('read',{path:${JSON.stringify(join(root, 'private-read-fixture.txt'))}});return {content:[{type:'text',text:'fixture'}],details:undefined};}});
}`);
  for (const [role, nested] of [['observer-fixture', false], ['observer-parent', true], ['observer-leaf', false]]) {
    writeFileSync(join(agentDir, 'agents', `${role}.md`), `---\nname: ${role}\ndescription: Local scripted session observer smoke\nmodel: observer-proof/${nested ? 'parent' : 'worker'}\ntools: read, proof_outer${nested ? ', subagent' : ''}\nextensions: []\nsubagentOnlyExtensions: ${scripted}\n${nested ? 'allowNestedSubagents: true\nallowedAgents: observer-leaf\n' : ''}---\nOnly the deterministic local adapter runs.\n`);
  }
  const manager = sdk.SessionManager.create(root, sessions);
  manager.appendMessage({ role: 'user', content: 'Synthetic parent fixture', timestamp: Date.now() });
  const activityPath = join(root, '.activity.json');
  let api, sequence = 0, parentModelRuns = 0, latest, observedResolve;
  const completions = new Map(), waiting = new Map();
  const allObserved = new Promise(resolve => { observedResolve = resolve; });
  const rpc = (method, params) => new Promise((resolve, reject) => {
    const id = `proof-${++sequence}`, timeout = setTimeout(() => { off(); reject(new Error('Root RPC timeout')); }, 20000);
    const off = api.events.on(`subagents:rpc:v1:reply:${id}`, reply => { clearTimeout(timeout); off();
      if (reply.success) resolve(reply.data); else { writeFileSync(join(root, 'rpc-failure.json'), JSON.stringify(reply), { mode: 0o600 }); reject(new Error('Root RPC failure')); }
    });
    api.events.emit('subagents:rpc:v1:request', { version: 1, requestId: id, method, params });
  });
  const complete = id => completions.has(id) ? Promise.resolve() : new Promise(resolve => waiting.set(id, resolve));
  const loader = new sdk.DefaultResourceLoader({ cwd: root, agentDir, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
    additionalExtensionPaths: [require.resolve('pi-subagents'), scripted], extensionFactories: [pi => {
      api = pi;
      installActivityBridge(pi, { env: { LIMILINK_ACTIVITY_PATH: activityPath, LIMILINK_ACTIVITY_OWNER_CWD: root, LIMILINK_ACTIVITY_SESSION_DIR: sessions, LIMILINK_ACTIVITY_CHILD_SESSIONS: '1' }, registerChildExtensions: registerRequiredChildExtensions,
        write(path, snapshot) { writeAtomicSnapshot(path, snapshot); latest = structuredClone(snapshot);
          const nodes = snapshot.nodes.filter(node => node.observation), tools = snapshot.events.filter(row => row.kind === 'tool' && nodes.some(node => node.id === row.nodeId));
          if (nodes.length === 5 && tools.length >= 10 && nodes.every(node => node.state === 'closed')) observedResolve();
        } });
      pi.on('agent_start', () => { parentModelRuns++; });
      pi.events.on('subagent:async-complete', event => { const id = event.runId ?? event.id; completions.set(id, event); waiting.get(id)?.(); });
    }] });
  await loader.reload(); assert.equal(loader.getExtensions().errors.length, 0);
  const { session } = await sdk.createAgentSession({ cwd: root, agentDir, sessionManager: manager, resourceLoader: loader, tools: [], settingsManager: sdk.SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } }) });
  const deadline = setTimeout(() => { console.error('Smoke observation deadline; fixture:', root); process.exitCode = 1; session.dispose(); observedResolve(); }, 30000);
  try {
    await session.bindExtensions({}); assert.equal(latest.sessionTracking.available, true);
    const launch = async agent => { const result = await rpc('spawn', { agent, task: 'Synthetic local SDK fixture', context: 'fresh', async: true, acceptance: { level: 'none', reason: 'Scripted SDK fixture' } }); assert.ok(result.details.runId); await complete(result.details.runId); };
    await launch('observer-fixture');
    const step = key => ({ key, label: `Observe ${key} session`, agent: 'observer-fixture', task: 'Synthetic local SDK fixture', context: 'fresh', acceptance: { level: 'none', reason: 'Scripted SDK fixture' } });
    const parallel = await rpc('spawn', { script: `await runs.all(${JSON.stringify([step('left'), step('right')])});`, async: true }); await complete(parallel.details.runId);
    await launch('observer-parent'); await allObserved;
    assert.equal(parentModelRuns, 0); assert.equal(existsSync(join(root, 'network-attempts')), false);
    const children = latest.nodes.filter(node => node.observation);
    assert.equal(children.length, 5); assert.equal(new Set(children.map(node => node.id)).size, 5);
    assert.equal(children.filter(node => node.parentId === 'parent').length, 4);
    assert.equal(children.filter(node => children.some(parent => parent.id === node.parentId)).length, 1);
    const tools = latest.events.filter(row => row.kind === 'tool' && children.some(node => node.id === row.nodeId));
    assert.equal(tools.length, 11); assert.ok(tools.every(row => row.state === 'finished'));
    assert.equal(tools.filter(row => row.parentEventId).length, 5);
    for (const row of tools.filter(row => row.parentEventId)) assert.equal(tools.find(parent => parent.id === row.parentEventId)?.nodeId, row.nodeId);
    assert.ok(children.every(node => node.observation.modelBasis === 'response' && node.lastInputTokens === 30));
    assert.ok(latest.events.some(row => row.kind === 'model' && row.nodeId.startsWith('session:') && row.label.includes('cached 18')));
    const publicJSON = JSON.stringify(latest);
    assert.ok(!publicJSON.includes(root)); assert.ok(!publicJSON.includes('PRIVATE_BODY_NEVER_IN_ACTIVITY'));
    assert.ok(latest.nodes.some(node => node.id.startsWith('async:')));
    // Verify production resolution from the ACTUAL managed Pi CLI, not the
    // SDK harness's injected registration function or temporary module symlink.
    const cliRoot = join(root, 'cli-host'), cliSessions = join(cliRoot, 'sessions');
    mkdirSync(cliSessions, { recursive: true });
    const pkgRoot = join(npmRoot, '@earendil-works/pi-coding-agent');
    const manifest = JSON.parse(readFileSync(join(pkgRoot, 'package.json')));
    const cliPath = join(pkgRoot, typeof manifest.bin === 'string' ? manifest.bin : manifest.bin.pi);
    const cliEnv = { ...process.env, LIMILINK_ACTIVITY_PATH: join(cliRoot, '.activity.json'), LIMILINK_ACTIVITY_OWNER_CWD: cliRoot, LIMILINK_ACTIVITY_SESSION_DIR: cliSessions, LIMILINK_ACTIVITY_CHILD_SESSIONS: '1' };
    delete cliEnv.PI_SUBAGENT_CHILD; delete cliEnv.LIMILINK_ACTIVITY_PID;
    const cli = spawn(process.execPath, [cliPath, '--mode', 'rpc', '--no-extensions', '--no-skills', '--session-dir', cliSessions, '--extension', fileURLToPath(new URL('../tool/activity-bridge.mjs', import.meta.url))], { cwd: cliRoot, env: cliEnv, stdio: ['pipe', 'pipe', 'pipe'] });
    const exited = once(cli, 'exit'), cliTimeout = setTimeout(() => cli.kill('SIGTERM'), 15000);
    cli.stderr.on('data', () => {});
    try {
      cli.stdin.write(JSON.stringify({ type: 'get_state', id: 'observer-proof' }) + '\n');
      let replied = false;
      for await (const line of createInterface({ input: cli.stdout })) {
        let event; try { event = JSON.parse(line); } catch { continue; }
        if (event.type === 'response' && event.command === 'get_state') { assert.equal(event.success, true); replied = true; break; }
      }
      assert.equal(replied, true);
      assert.equal(JSON.parse(readFileSync(cliEnv.LIMILINK_ACTIVITY_PATH)).sessionTracking.available, true, 'Actual CLI public export resolution');
      assert.equal(existsSync(join(root, 'network-attempts')), false);
    } finally { clearTimeout(cliTimeout); cli.kill('SIGTERM'); await exited; }
    const scriptedStreams = readFileSync(join(root, 'scripted-streams'), 'utf8').trim().split('\n').length;
    console.log(JSON.stringify({ passed: true, stockVersion: '0.78.0', observerSessions: 5, realSDKToolRows: tools.length, nestedSession: true, actualCLIResolution: true, scriptedStreams, realModelProviderCalls: 0, networkAttempts: 0, scope: 'stock-SDK-with-local-scripted-responses', fixture: root }));
  } finally {
    clearTimeout(deadline); await session.extensionRunner?.emit({ type: 'session_shutdown', reason: 'quit' }); session.dispose();
  }
}

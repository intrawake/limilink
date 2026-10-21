import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, statSync, openSync, closeSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { contextUsage, installActivityBridge, mapSubagents, responseUsageLabel, writeAtomicSnapshot } from '../tool/activity-bridge.mjs';

const REQUEST = 'subagents:rpc:v1:request';
const REPLY = 'subagents:rpc:v1:reply:';
const env = { LIMILINK_ACTIVITY_PATH: '/session/.activity.json', LIMILINK_ACTIVITY_SESSION_DIR: '/session/.pi/agent/session', LIMILINK_ACTIVITY_OWNER_CWD: '/session' };
function harness(overrides = {}) {
  let clock = 1700000000000;
  const handlers = new Map(), listeners = new Map(), timers = new Map();
  const writes = [], requests = [];
  const ctx = { cwd: '/session', model: { id: 'gpt-example' }, isIdle: () => true,
    sessionManager: { getHeader: () => ({ id: 'pi-id' }), getSessionId: () => 'pi-id', getSessionFile: () => '/session/.pi/agent/session/main.jsonl' },
    getContextUsage: () => ({ tokens: 20, contextWindow: 100, percent: 20 }) };
  const pi = { on(event, handler) { handlers.set(event, handler); }, events: {
    on(event, handler) { listeners.set(event, handler); return () => listeners.delete(event); },
    emit(event, data) { if (event === REQUEST) requests.push(data); listeners.get(event)?.(data); },
  } };
  installActivityBridge(pi, { env, pid: 42, now: () => clock,
    setInterval(fn) { const id = Symbol(); timers.set(id, fn); return id; },
    clearInterval(id) { timers.delete(id); },
    write(path, snapshot) { writes.push({ path, snapshot: structuredClone(snapshot) }); }, ...overrides });
  return { ctx, pi, timers, writes, requests, listeners,
    emit(event, data = {}, candidate = ctx) { return handlers.get(event)?.(data, candidate); },
    tick(ms = 1000) { clock += ms; for (const fn of timers.values()) fn(); },
    snapshot() { return writes.at(-1)?.snapshot; },
    reply(data, request = requests.at(-1), extra = {}) { pi.events.emit(`${REPLY}${request.requestId}`, { version: 1, requestId: request.requestId, success: true, data, ...extra }); },
  };
}
const asyncData = (runs) => ({ asyncSnapshot: { version: 1, kind: 'pi-subagents.async-status-snapshot', runs } });
const CHILD_COMPLETE = 'subagent:async-complete';
const childCompletion = (h, extra = {}) => ({ lifecycleArtifactVersion: 3, id: 'run', runId: 'run', mode: 'single', state: 'complete',
  sessionId: h.ctx.sessionManager.getSessionFile(), timestamp: h.snapshot().updatedAt,
  results: [{ model: 'provider/child', usage: { input: 1234, output: 56, cacheRead: 9000, cacheWrite: 0 } }], ...extra });
const singleRun = () => asyncData([{ id: 'run', kind: 'subagent', state: 'complete', label: 'trainee', children: [
  { id: 'execution', kind: 'step', state: 'complete', label: 'trainee' },
] }]);

test('factory is inert until session_start; valid persisted owner works without PID wrapper', () => {
  const h = harness();
  assert.equal(h.writes.length, 0); assert.equal(h.timers.size, 0); assert.equal(h.requests.length, 0);
  h.emit('session_start');
  assert.equal(h.timers.size, 1);
  assert.equal(h.snapshot().sessionId, 'pi-id');
  assert.equal(h.snapshot().nodes[0].id, 'parent');
  assert.equal(h.snapshot().context.basis, 'estimate');
  assert.equal(h.requests[0].method, 'status');
  assert.deepEqual(h.requests[0].params, {});
  h.emit('session_shutdown');
});

test('child runtimes, non-owner sessions and optional wrong PID cannot write or poll', () => {
  const cases = [
    { env: { ...env, PI_SUBAGENT_CHILD: '1' } },
    { env: { ...env, LIMILINK_ACTIVITY_PID: '43' } },
    { env: { ...env, LIMILINK_ACTIVITY_SESSION_DIR: '' } },
    { env: { ...env, LIMILINK_ACTIVITY_OWNER_CWD: '' } },
    { env: { ...env, LIMILINK_ACTIVITY_PATH: 'relative.json' } },
  ];
  for (const options of cases) {
    const h = harness(options); h.emit('session_start'); h.emit('agent_start'); h.tick(); h.emit('session_shutdown');
    assert.equal(h.writes.length, 0); assert.equal(h.requests.length, 0); assert.equal(h.timers.size, 0);
  }
  const mutations = [
    (c) => { c.sessionManager.getHeader = () => ({ parentSession: '/parent.jsonl' }); },
    (c) => { c.sessionManager.getHeader = () => ({ parentSession: '' }); },
    (c) => { c.sessionManager.getHeader = () => null; },
    (c) => { c.sessionManager.getSessionFile = () => undefined; },
    // Same PID, same cwd, no header attribution: child artifact directory still excludes it.
    (c) => { c.sessionManager.getSessionFile = () => '/session/.pi/agent/session/main/run-1/session.jsonl'; },
    (c) => { c.cwd = '/other-session'; },
    (c) => { c.sessionManager.getSessionId = () => '/secret/mailbox'; },
    (c) => { c.sessionManager.getHeader = () => { throw Error('unavailable'); }; },
  ];
  for (const mutate of mutations) {
    const h = harness({ env: { ...env, LIMILINK_ACTIVITY_PID: '42' } }); mutate(h.ctx);
    h.emit('session_start'); h.emit('agent_start'); h.tick(); h.emit('session_shutdown');
    assert.equal(h.writes.length, 0); assert.equal(h.requests.length, 0); assert.equal(h.timers.size, 0);
  }
});

test('in-process child extension instance cannot overwrite active parent snapshot', () => {
  const snapshots = [];
  const write = (_path, snapshot) => snapshots.push(snapshot);
  const parent = harness({ write }); parent.emit('session_start');
  const child = harness({ write });
  child.ctx.sessionManager.getHeader = () => ({ parentSession: '/session/.pi/agent/session/main.jsonl' });
  child.ctx.sessionManager.getSessionFile = () => '/session/.pi/agent/session/main/run-0/session.jsonl';
  child.emit('session_start'); child.emit('agent_start'); child.tick(); child.emit('session_shutdown');
  assert.equal(snapshots.length, 1); assert.equal(snapshots[0].sessionId, 'pi-id');
  parent.emit('agent_start'); assert.equal(snapshots.at(-1).state, 'working');
  parent.emit('session_shutdown');
});

test('simultaneous and nested tool executions use independent identities and never export args/results', () => {
  const h = harness(); h.emit('session_start'); h.emit('agent_start');
  for (const [toolCallId, toolName, parentToolCallId] of [['a', 'codemode'], ['a/1', 'read', 'a'], ['a/2', 'bash', 'a'], ['b', 'read']]) {
    h.emit('tool_execution_start', { toolCallId, toolName, parentToolCallId, args: { token: 'credential-secret' } });
  }
  assert.deepEqual(h.snapshot().tools.map(t => t.name), ['codemode', 'read', 'bash', 'read']);
  assert.equal(new Set(h.snapshot().tools.map(t => t.id)).size, 4);
  h.emit('tool_execution_end', { toolCallId: 'a/1', toolName: 'read', result: { content: 'credential-secret' } });
  assert.deepEqual(h.snapshot().tools.map(t => t.name), ['codemode', 'bash', 'read']);
  h.emit('agent_end'); assert.equal(h.snapshot().state, 'working');
  h.emit('agent_settled', { aborted: false }); assert.equal(h.snapshot().state, 'idle');
  assert.deepEqual(h.snapshot().tools, []);
  assert.ok(!JSON.stringify(h.writes).includes('credential-secret'));
  h.emit('session_shutdown');
});

test('tool rows update in place, retain first-observed order and expose explicit parent linkage only', () => {
  const h = harness(); h.emit('session_start');
  const start = (toolCallId, toolName, parentToolCallId) => h.emit('tool_execution_start', { toolCallId, toolName, parentToolCallId, args: 'SECRET' });
  const end = (toolCallId, toolName, extra = {}) => h.emit('tool_execution_end', { toolCallId, toolName, durationMs: 12, ...extra, result: { content: 'SECRET' } });
  start('outer', 'codemode'); start('outer/a', 'read', 'outer'); start('outer/b', 'bash', 'outer'); start('unrelated', 'read');
  const rows = h.snapshot().events.filter(row => row.kind === 'tool');
  assert.equal(rows.length, 4);
  assert.equal(rows[1].parentEventId, rows[0].id); assert.equal(rows[2].parentEventId, rows[0].id);
  assert.equal(rows[3].parentEventId, undefined);
  h.tick(); start('outer/a', 'read', 'outer');
  end('outer/b', 'bash', { isError: true }); end('outer', 'codemode'); end('outer/a', 'read'); end('outer/a', 'read');
  start('outer/a', 'read', 'outer'); // Late duplicate must not restart completed work.
  const finished = h.snapshot().events.filter(row => row.kind === 'tool');
  assert.deepEqual(finished.map(row => row.id), rows.map(row => row.id));
  assert.deepEqual(finished.map(row => row.at), rows.map(row => row.at));
  assert.deepEqual(finished.map(row => row.state), ['finished', 'finished', 'failed', 'running']);
  assert.equal(finished[1].label, 'Finished read · 12ms');
  assert.deepEqual(h.snapshot().tools.map(tool => tool.name), ['read']);
  assert.ok(!JSON.stringify(h.snapshot()).includes('SECRET'));
  h.emit('session_shutdown');
});

test('parent metadata can arrive at end or before the parent; missing start does not invent time/duration', () => {
  const h = harness(); h.emit('session_start');
  h.emit('tool_execution_start', { toolCallId: 'child', toolName: 'read' });
  h.tick();
  h.emit('tool_execution_end', { toolCallId: 'child', toolName: 'read', parentToolCallId: 'SECRET/parent' });
  const child = h.snapshot().events.find(row => row.kind === 'tool');
  assert.equal(child.at, 1700000000000); assert.equal(child.state, 'finished');
  h.emit('tool_execution_start', { toolCallId: 'SECRET/parent', toolName: 'codemode' });
  assert.equal(child.parentEventId, h.snapshot().events.at(-1).id);
  h.emit('tool_execution_end', { toolCallId: 'child', toolName: 'read' });
  assert.equal(h.snapshot().events.find(row => row.id === child.id).parentEventId, child.parentEventId);
  h.emit('tool_execution_end', { toolCallId: 'end-only', toolName: 'bash', parentToolCallId: 'end-only' });
  assert.equal(h.snapshot().events.at(-1).at, 1700000001000);
  assert.equal(h.snapshot().events.at(-1).label, 'Finished bash');
  assert.equal(h.snapshot().events.at(-1).parentEventId, undefined);
  assert.ok(!JSON.stringify(h.snapshot()).includes('SECRET'));
  h.emit('session_shutdown');
});

test('bounded history can lose parents and reintroduce completion without retaining an unbounded trace', () => {
  const h = harness(); h.emit('session_start');
  for (const [toolCallId, parentToolCallId] of [['outer', undefined], ['a', 'outer'], ['b', 'outer']]) {
    h.emit('tool_execution_start', { toolCallId, toolName: 'read', parentToolCallId });
  }
  const parentId = h.snapshot().events.find(row => row.kind === 'tool').id;
  const childId = h.snapshot().events.at(-1).id;
  for (let i = 0; i < 38; i++) h.emit('message_end', { message: { role: 'assistant', usage: { input: 1 } } });
  assert.equal(h.snapshot().events.length, 40);
  assert.ok(!h.snapshot().events.some(row => row.id === parentId));
  assert.equal(h.snapshot().events.find(row => row.id === childId).parentEventId, parentId);
  h.tick(); h.emit('tool_execution_end', { toolCallId: 'outer', toolName: 'read' });
  assert.equal(h.snapshot().events.length, 40);
  assert.equal(h.snapshot().events.at(-1).id, parentId);
  assert.equal(h.snapshot().events.at(-1).at, 1700000001000);
  assert.ok(h.snapshot().events.some(row => row.id === childId));
  h.emit('session_shutdown');
});

test('final settlement and shutdown close running observations without manufacturing successful outcomes', () => {
  const h = harness(); h.emit('session_start'); h.emit('agent_start');
  for (let i = 0; i < 100; i++) h.emit('tool_execution_start', { toolCallId: `call-${i}`, toolName: 'read' });
  h.emit('tool_execution_end', { toolCallId: 'call-99', toolName: 'read', isError: true });
  const failedId = h.snapshot().events.at(-1).id;
  h.emit('agent_end');
  assert.ok(h.snapshot().events.some(row => row.state === 'running'));
  h.emit('agent_settled', { aborted: false });
  assert.equal(h.snapshot().tools.length, 0);
  assert.ok(h.snapshot().events.filter(row => row.kind === 'tool' && row.id !== failedId).every(row => row.state === 'unknown' && row.label === 'Outcome not observed read'));
  assert.equal(h.snapshot().events.find(row => row.id === failedId).state, 'failed');
  h.emit('tool_execution_end', { toolCallId: 'call-98', toolName: 'read', durationMs: 2 });
  assert.ok(h.snapshot().events.some(row => row.label === 'Finished read · 2ms'));
  h.emit('tool_execution_start', { toolCallId: 'call-98', toolName: 'read' });
  assert.equal(h.snapshot().tools.length, 0);
  h.emit('agent_start'); h.emit('tool_execution_start', { toolCallId: 'aborted', toolName: 'bash' });
  h.emit('agent_settled', { aborted: true });
  assert.ok(h.snapshot().events.some(row => row.state === 'stopped' && row.label === 'Stopped bash'));
  h.emit('tool_execution_start', { toolCallId: 'shutdown', toolName: 'bash' });
  h.emit('session_shutdown');
  assert.ok(!h.snapshot().events.some(row => row.state === 'running'));
  h.emit('session_start');
  assert.equal(h.snapshot().events.length, 1); assert.equal(h.snapshot().tools.length, 0);
  h.emit('session_shutdown');
});

test('invalid tool IDs cannot bypass privacy bounds or suppress independent supervisor reply observations', () => {
  const h = harness(); h.emit('session_start');
  h.reply(asyncData([{ id: 'run-1', kind: 'workflow', state: 'running' }]));
  h.emit('tool_execution_end', { toolCallId: 'SECRET'.repeat(200), toolName: 'subagent_supervisor',
    result: { details: { replyTo: 'request-1', runId: 'run-1' }, content: 'SECRET' } });
  assert.ok(h.snapshot().edges.some(edge => edge.kind === 'reply'));
  assert.ok(!JSON.stringify(h.snapshot()).includes('SECRET'));
  h.emit('session_shutdown');
});

test('compaction invalidates context through polls and settlement until fresh successful assistant response', () => {
  const h = harness(); h.emit('session_start');
  assert.equal(h.snapshot().context.tokens, 20);
  h.emit('session_compact', { compactionEntry: { summary: 'private summary' } });
  assert.equal(h.snapshot().context, null); assert.equal(h.snapshot().nodes[0].context, undefined);
  assert.equal(h.snapshot().events.at(-1).kind, 'context');
  assert.equal(h.snapshot().events.at(-1).label, 'Context compacted');
  assert.ok(!JSON.stringify(h.snapshot()).includes('private summary'));
  h.tick(); h.emit('agent_settled', { aborted: false });
  assert.equal(h.snapshot().context, null);
  h.emit('message_end', { message: { role: 'user' } }); assert.equal(h.snapshot().context, null);
  h.emit('message_end', { message: { role: 'assistant', stopReason: 'error', content: 'private provider error' } });
  assert.equal(h.snapshot().context, null); assert.equal(h.snapshot().state, 'error');
  h.emit('agent_start');
  h.ctx.getContextUsage = () => ({ tokens: 5, contextWindow: 200, percent: 2.5 });
  h.emit('message_end', { message: { role: 'assistant', stopReason: 'stop' } });
  assert.equal(h.snapshot().context.tokens, 5); assert.equal(h.snapshot().context.observedAt, 1700000001000);
  h.emit('session_shutdown');
});

test('successful automatic recovery clears error and normal shutdown retains idle state', () => {
  const h = harness(); h.emit('session_start'); h.emit('agent_start');
  h.emit('message_end', { message: { role: 'assistant', stopReason: 'error' } });
  assert.equal(h.snapshot().state, 'error');
  h.emit('message_end', { message: { role: 'assistant', stopReason: 'stop' } });
  assert.equal(h.snapshot().state, 'working');
  h.emit('agent_settled', { aborted: false });
  h.emit('session_shutdown');
  assert.equal(h.snapshot().state, 'idle');
});

test('context usage validates unknown values without inventing occupancy', () => {
  assert.equal(contextUsage(undefined, 1), null);
  assert.equal(contextUsage({ tokens: 5, contextWindow: 0, percent: 5 }, 1), null);
  assert.deepEqual(contextUsage({ tokens: null, contextWindow: 100, percent: 90 }, 1),
    { tokens: null, contextWindow: 100, percent: null, observedAt: 1, basis: 'estimate' });
  assert.equal(contextUsage({ tokens: Infinity, contextWindow: 100, percent: NaN }, 1).tokens, null);
});

test('response labels preserve separate token categories, explicit zeros and unknowns', () => {
  assert.equal(responseUsageLabel({ usage: { input: 1234, output: 56, cacheRead: 8000, cacheWrite: 0, totalTokens: 9290, cost: 'SECRET' } }),
    'Model · cached 8k · in 1.2k · out 56');
  assert.equal(responseUsageLabel({ usage: { input: 12345, output: 678, cacheRead: 9000, cacheWrite: 1500 } }),
    'Model · cached 9k · in 12.3k · out 678 · write 1.5k');
  assert.equal(responseUsageLabel({ usage: { input: 1234567, output: 0, cacheRead: 0, cacheWrite: 0 } }),
    'Model · cached 0 · in 1.2M · out 0');
  assert.equal(responseUsageLabel({ usage: { input: 10, output: 'SECRET', cacheRead: -1, cacheWrite: NaN } }),
    'Model · cached ? · in 10 · out ? · write ?');
  assert.equal(responseUsageLabel({ usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }), 'Model · usage not reported');
  assert.equal(responseUsageLabel({}), 'Model · usage not reported');
  assert.equal(responseUsageLabel({ stopReason: 'error', usage: { input: Infinity, output: -1 } }), 'Model (error) · usage not reported');
  assert.equal(responseUsageLabel({ stopReason: 'aborted', usage: { input: 1.5, output: Number.MAX_SAFE_INTEGER + 1 } }), 'Model (aborted) · usage not reported');
  const maximal = { input: Number.MAX_SAFE_INTEGER, output: Number.MAX_SAFE_INTEGER, cacheRead: Number.MAX_SAFE_INTEGER, cacheWrite: Number.MAX_SAFE_INTEGER };
  assert.ok(responseUsageLabel({ stopReason: 'aborted', usage: maximal }).length <= 200);
});

test('recent model rows are per-response only, bounded and do not export raw message/tool data', () => {
  const h = harness(); h.emit('session_start'); h.emit('agent_start');
  h.emit('message_start', { message: { role: 'assistant', usage: { input: 0 } } });
  assert.equal(h.snapshot().events.filter(event => event.kind === 'model').length, 0);
  h.emit('message_end', { message: { role: 'assistant', stopReason: 'toolUse', content: 'SECRET thinking', usage: { input: 100, output: 10, cacheRead: 50, cacheWrite: 0 } } });
  h.emit('tool_execution_end', { toolName: 'read', toolCallId: 'read-1', durationMs: 1234, result: { content: 'SECRET result' } });
  h.emit('message_end', { message: { role: 'toolResult', usage: { input: 999999 }, content: 'SECRET tool message' } });
  h.emit('message_end', { message: { role: 'assistant', stopReason: 'stop', content: 'SECRET answer', usage: { input: 150, output: 20, cacheRead: 80, cacheWrite: 5 } } });
  const models = h.snapshot().events.filter(event => event.kind === 'model');
  assert.equal(models.length, 2);
  assert.equal(models[0].label, 'Model · cached 50 · in 100 · out 10');
  assert.equal(models[1].label, 'Model · cached 80 · in 150 · out 20 · write 5');
  assert.ok(h.snapshot().events.some(event => event.label === 'Finished read · 1,234ms'));
  assert.ok(!JSON.stringify(h.snapshot()).includes('SECRET'));
  assert.ok(!JSON.stringify(h.snapshot()).includes('999999'));
  for (let i = 0; i < 100; i++) h.emit('message_end', { message: { role: 'assistant', stopReason: 'error', usage: { input: i + 1 } } });
  assert.equal(h.snapshot().events.length, 40);
  assert.ok(h.snapshot().events.every(event => event.label.length <= 200 && event.nodeId === 'parent'));
  h.emit('session_shutdown');
});

test('missing/invalid tool duration is not invented and errors retain measured duration', () => {
  const h = harness(); h.emit('session_start');
  for (const durationMs of [undefined, -1, Infinity, 'SECRET']) {
    h.emit('tool_execution_end', { toolName: 'read', toolCallId: 'read-1', durationMs });
    assert.equal(h.snapshot().events.at(-1).label, 'Finished read');
  }
  h.emit('tool_execution_end', { toolName: 'read', toolCallId: 'read-1', durationMs: 0, isError: true });
  assert.equal(h.snapshot().events.at(-1).label, 'Failed read · 0ms');
  h.emit('session_shutdown');
});

test('RPC projects explicit hierarchy only; opaque fleet cards remain disconnected and sanitized', () => {
  const h = harness(); h.emit('session_start');
  const data = asyncData([{ id: 'run-1', kind: 'workflow', state: 'running', label: 'Review activity bridge', children: [
    { id: 'step-0', kind: 'step', state: 'complete', label: '/private/mailbox', activity: { currentTool: 'read', thinking: 'private thinking' } },
  ] }, { id: 'run-2', kind: 'workflow', state: 'paused', children: [{ id: 'step-0', kind: 'step', state: 'failed' }] }]);
  data.text = 'private raw result'; data.details = { credentials: 'private credential' };
  data.fleet = { version: 1, entries: [{ key: 'opaque:/private/mailbox', agent: 'specialist', model: 'provider/model', goal: 'private goal', tokens: { input: 1234567, window: 123, output: 456, total: 1235023 } }] };
  h.reply(data);
  const s = h.snapshot();
  assert.equal(s.subagentsAvailable, true); assert.equal(s.nodes.length, 6); assert.equal(s.edges.length, 4);
  assert.equal(new Set(s.nodes.map(n => n.id)).size, s.nodes.length);
  const fleet = s.nodes.find(n => n.id.startsWith('fleet:'));
  assert.equal(fleet.parentId, null); assert.equal(fleet.context, undefined);
  assert.equal(fleet.lastInputTokens, 123); assert.equal(fleet.model, 'provider/model');
  assert.equal(s.nodes[1].label, 'Review activity bridge');
  assert.ok(!JSON.stringify(s).includes('1234567'));
  assert.equal(mapSubagents({ fleet: { version: 1, entries: [{ key: 'k', agent: 'worker', tokens: { input: 999999 } }] } }, 1).nodes[0].lastInputTokens, undefined);
  assert.ok(s.edges.every(e => e.kind === 'delegation' && e.target !== fleet.id));
  assert.equal(s.nodes.find(n => n.currentTool === 'read').state, 'complete');
  assert.ok(!JSON.stringify(s).includes('private')); assert.ok(!JSON.stringify(s).includes('579'));
  assert.equal(h.listeners.size, 1); // Owning-session completion subscription remains.
  h.emit('session_shutdown'); assert.equal(h.listeners.size, 0);
});

test('sole complete execution row folds into its run, retaining real nested agents and run identity', () => {
  const data = asyncData([{ id: 'run', kind: 'subagent', label: 'trainee', state: 'running', updatedAt: 20, children: [
    { id: 'execution', kind: 'step', label: 'trainee', state: 'running', activity: { currentTool: 'read' }, model: 'SECRET', children: [
      { id: 'real-child', kind: 'subagent', label: 'trainee', state: 'complete' },
    ] },
  ] }]);
  data.asyncSnapshot.omitted = { children: 0 };
  const graph = mapSubagents(data, 30);
  assert.equal(graph.nodes.length, 2); assert.equal(graph.edges.length, 2);
  const [run, child] = graph.nodes;
  assert.equal(run.id, mapSubagents(asyncData([{ id: 'run', kind: 'subagent', state: 'running' }]), 30).nodes[0].id);
  assert.equal(run.parentId, 'parent'); assert.equal(child.parentId, run.id);
  assert.equal(run.state, 'running'); assert.equal(run.updatedAt, 20); assert.equal(run.currentTool, 'read');
  assert.equal(child.label, 'trainee'); assert.equal(child.kind, 'agent');
  assert.equal(run.model, undefined); assert.equal(run.context, undefined);
  assert.ok(!JSON.stringify(graph).includes('SECRET'));
  data.asyncSnapshot.runs[0].activity = { currentTool: 'bash' };
  assert.equal(mapSubagents(data, 30).nodes[0].currentTool, 'bash');
  data.asyncSnapshot.runs[0].state = 'complete'; data.asyncSnapshot.runs[0].children[0].state = 'complete';
  delete data.asyncSnapshot.runs[0].activity;
  assert.equal(mapSubagents(data, 30).nodes[0].currentTool, undefined, 'Terminal run acquired stale step activity');
  const h = harness(); h.emit('session_start'); h.reply(data);
  h.emit('message_end', { message: { role: 'custom', customType: 'subagent_supervisor_request', details: {
    requestId: 'request', runId: 'run', reason: 'progress_update',
  } } });
  assert.equal(h.snapshot().edges.find(edge => edge.kind === 'message').source, run.id);
  h.emit('session_shutdown');
});

test('ambiguous, truncated, conflicting and non-subagent containers retain execution rows', () => {
  const base = () => ({ id: 'run', kind: 'subagent', label: 'trainee', state: 'complete', children: [
    { id: 'self', kind: 'step', label: 'trainee', state: 'complete' },
  ] });
  const project = (row, omitted = { children: 0 }) => {
    const data = asyncData([row]); data.asyncSnapshot.omitted = omitted;
    return mapSubagents(data, 1);
  };
  for (const omitted of [undefined, {}, { children: 1 }]) {
    const data = asyncData([base()]); data.asyncSnapshot.omitted = omitted;
    assert.equal(mapSubagents(data, 1).nodes.length, 2, 'Incomplete cardinality was guessed to be a sole execution');
  }
  for (const kind of ['workflow', 'step', 'host-step', 'unknown']) {
    const row = base(); row.kind = kind;
    assert.equal(project(row).nodes.length, 2, `Folded ${kind} as an agent run`);
  }
  for (const kind of ['subagent', 'host-step', 'unknown']) {
    const row = base(); row.children[0].kind = kind;
    assert.equal(project(row).nodes.length, 2, `Folded ${kind} as an execution step`);
  }
  for (const kind of ['subagent', 'host-step']) {
    const row = base(); row.children.push({ id: 'sibling', label: 'trainee', kind, state: 'complete' });
    assert.equal(project(row).nodes.length, 3, 'Sibling was hidden');
  }
  const failed = base(); failed.state = 'failed';
  assert.equal(project(failed).nodes.length, 2); assert.equal(project(failed).nodes[0].state, 'failed');
  const stepFailed = base(); stepFailed.children[0].state = 'failed';
  assert.equal(project(stepFailed).nodes.length, 2); assert.equal(project(stepFailed).nodes[1].state, 'failed');
  const invalid = base(); invalid.children[0].id = '';
  assert.equal(project(invalid).nodes.length, 1);
});

test('folding consumes source depth and cannot bypass graph budgets', () => {
  let run = { id: 'leaf', kind: 'subagent', state: 'running' };
  for (let i = 11; i >= 0; i--) run = { id: `run-${i}`, kind: 'subagent', state: 'running', children: [
    { id: `execution-${i}`, kind: 'step', state: 'running', children: [run] },
  ] };
  const data = asyncData([run]); data.asyncSnapshot.omitted = { children: 0 };
  const graph = mapSubagents(data, 1);
  assert.equal(graph.nodes.length, 5); assert.equal(graph.edges.length, 5);
  const many = asyncData(Array.from({ length: 200 }, (_, index) => ({ ...run, id: `wide-${index}` })));
  many.asyncSnapshot.omitted = { children: 0 };
  const bounded = mapSubagents(many, 1);
  assert.equal(bounded.nodes.length, 63); assert.ok(bounded.edges.length <= 128);
  assert.ok(bounded.edges.every(edge => edge.source === 'parent' || bounded.nodes.some(node => node.id === edge.source)));
});

test('node/edge/tool/event counts and strings stay bounded with hostile or oversized observations', () => {
  const many = Array.from({ length: 200 }, (_, i) => ({ id: `run-${i}`, kind: 'workflow', state: 'running',
    label: 'SECRET'.repeat(10000), activity: { currentTool: 'SECRET'.repeat(1000) }, children: [{ id: 'step', kind: 'step', state: 'complete' }] }));
  const graph = mapSubagents({ ...asyncData(many), fleet: { version: 1, entries: many.map(row => ({ key: row.id, agent: 'SECRET'.repeat(1000) })) } }, 1);
  assert.ok(graph.nodes.length <= 63); assert.ok(graph.edges.length <= 128);
  assert.ok(!JSON.stringify(graph).includes('SECRET'));
  assert.ok(graph.edges.every(e => e.source === 'parent' || graph.nodes.some(n => n.id === e.source)));
  const h = harness(); h.emit('session_start');
  for (let i = 0; i < 200; i++) h.emit('tool_execution_start', { toolCallId: `call-${i}`, toolName: 'read', args: 'SECRET' });
  assert.equal(h.snapshot().tools.length, 64); assert.equal(h.snapshot().events.length, 40);
  assert.ok(Buffer.byteLength(JSON.stringify(h.snapshot())) < 512 * 1024);
  for (let i = 0; i < 200; i++) h.emit('tool_execution_end', { toolCallId: `call-${i}`, toolName: 'read' });
  assert.equal(h.snapshot().tools.length, 0);
  h.emit('session_shutdown');
});

test('native supervisor metadata yields only exactly correlated run-level request/reply edges', () => {
  const h = harness(); h.emit('session_start');
  h.reply(asyncData([{ id: 'run-1', kind: 'workflow', state: 'running', children: [{ id: 'step-key', kind: 'step', state: 'running' }] }]));
  const request = { message: { role: 'custom', customType: 'subagent_supervisor_request',
    content: 'SECRET request body', details: { requestId: 'request-1', runId: 'run-1', reason: 'need_decision',
      requestBody: 'SECRET body', childTarget: '/SECRET/mailbox', interview: { task: 'SECRET interview' }, childIndex: 0 } } };
  h.emit('message_end', request); h.emit('message_end', request);
  const reply = { toolCallId: 'reply-call', toolName: 'subagent_supervisor', isError: false,
    result: { content: [{ text: 'SECRET reply' }], details: { replyTo: 'request-1', runId: 'run-1', agent: 'SECRET role' } } };
  h.emit('tool_execution_end', reply); h.emit('tool_execution_end', reply);
  const edges = h.snapshot().edges.filter(e => e.kind !== 'delegation');
  assert.equal(edges.length, 2);
  const run = h.snapshot().nodes.find(n => n.parentId === 'parent');
  assert.equal(edges[0].kind, 'message'); assert.equal(edges[0].source, run.id); assert.equal(edges[0].target, 'parent');
  assert.equal(edges[1].kind, 'reply'); assert.equal(edges[1].source, 'parent'); assert.equal(edges[1].target, run.id);
  assert.equal(edges[0].at, 1700000000000);
  assert.ok(!JSON.stringify(h.snapshot()).includes('SECRET'));
  // Refresh removing a run must also remove its communication edges.
  h.tick(); h.reply(asyncData([]));
  assert.equal(h.snapshot().edges.length, 0);
  h.emit('session_shutdown');
});

test('supervisor mapping omits unobserved, step-only, foreign-channel and failed-reply observations; history is bounded', () => {
  const h = harness(); h.emit('session_start');
  const message = (runId, requestId, customType = 'subagent_supervisor_request') => ({ message: { role: 'custom', customType,
    details: { requestId, runId, reason: 'progress_update' } } });
  h.emit('message_end', message('run-1', 'too-early'));
  h.reply(asyncData([{ id: 'run-1', kind: 'workflow', state: 'running', children: [{ id: 'step-key', kind: 'step', state: 'running' }] }]));
  h.emit('message_end', message('step-key', 'not-a-run'));
  h.emit('message_end', message('run-1', 'foreign', 'intercom-message'));
  h.emit('message_end', message('missing-run', 'unknown'));
  h.emit('tool_execution_end', { toolCallId: 'failed', toolName: 'subagent_supervisor', isError: true,
    result: { details: { replyTo: 'failed-request', runId: 'run-1' } } });
  assert.ok(h.snapshot().edges.every(e => e.kind === 'delegation'));
  for (let i = 0; i < 100; i++) h.emit('message_end', message('run-1', `update-${i}`));
  const edges = h.snapshot().edges.filter(e => e.kind === 'message');
  assert.equal(edges.length, 40); assert.ok(edges.every(e => e.label === 'Supervisor update'));
  assert.equal(h.snapshot().events.length, 40);
  h.emit('session_shutdown');
});

test('RPC unavailable, timeout, wrong replies, and shutdown release all resources without model calls', () => {
  const h = harness(); h.emit('session_start');
  assert.equal(h.snapshot().subagentsAvailable, false); assert.equal(h.listeners.size, 2);
  h.tick(1000); assert.equal(h.requests.length, 1);
  const expired = h.requests[0]; h.tick(5000);
  assert.equal(h.requests.length, 2); assert.equal(h.listeners.size, 2);
  h.reply(asyncData([]), expired); assert.equal(h.snapshot().subagentsAvailable, false);
  h.reply(asyncData([]), h.requests.at(-1), { success: false, error: { message: 'private error' } });
  assert.equal(h.snapshot().subagentsAvailable, false); assert.equal(h.listeners.size, 1);
  h.tick(); const pending = h.requests.at(-1);
  h.emit('session_shutdown');
  assert.equal(h.snapshot().state, 'idle'); assert.equal(h.timers.size, 0); assert.equal(h.listeners.size, 0);
  const n = h.writes.length;
  h.reply(asyncData([]), pending); h.tick(); h.emit('session_shutdown');
  assert.equal(h.writes.length, n);
});

test('native single-child completion enriches only its exact root with reported model and cumulative usage', () => {
  const h = harness(); h.emit('session_start');
  const graph = singleRun(); graph.asyncSnapshot.omitted = { children: 0 }; h.reply(graph);
  const node = h.snapshot().nodes[1], completion = childCompletion(h);
  completion.summary = 'SECRET body'; completion.sessionFile = '/SECRET/session'; completion.results[0].output = 'SECRET output';
  completion.results[0].usage.cost = 123456789;
  h.pi.events.emit(CHILD_COMPLETE, completion);
  let snapshot = h.snapshot(), event = snapshot.events.find(row => row.kind === 'usage');
  assert.equal(snapshot.nodes.length, 2); assert.equal(snapshot.nodes[1].model, 'provider/child');
  assert.equal(snapshot.nodes[1].state, 'complete'); assert.equal(snapshot.nodes[1].context, undefined);
  assert.equal(snapshot.nodes[1].lastInputTokens, undefined);
  assert.equal(event.nodeId, node.id); assert.equal(event.label, 'Reported run total · cached 9k · in 1.2k · out 56');
  assert.notEqual(event.nodeId, 'parent'); assert.equal(event.at, completion.timestamp);
  assert.ok(!JSON.stringify(snapshot).includes('SECRET')); assert.ok(!JSON.stringify(snapshot).includes('123456789'));
  assert.ok(!JSON.stringify(snapshot).includes(h.ctx.sessionManager.getSessionFile()));
  assert.equal(snapshot.eligibleRoots, undefined);
  const firstAt = event.at;
  h.pi.events.emit(CHILD_COMPLETE, completion);
  const conflict = structuredClone(completion); conflict.results[0].usage.input = 99999;
  h.pi.events.emit(CHILD_COMPLETE, conflict);
  assert.equal(h.snapshot().events.filter(row => row.kind === 'usage').length, 1);
  assert.equal(h.snapshot().events.find(row => row.kind === 'usage').label, event.label);
  h.tick(); h.reply(graph); // A status refresh must not erase the enrichment.
  assert.equal(h.snapshot().nodes[1].model, 'provider/child');
  const newer = childCompletion(h); newer.results[0].usage.input = 2345;
  h.pi.events.emit(CHILD_COMPLETE, newer);
  event = h.snapshot().events.find(row => row.kind === 'usage');
  assert.equal(event.label, 'Reported run total · cached 9k · in 2.3k · out 56'); assert.equal(event.at, firstAt);
  h.pi.events.emit(CHILD_COMPLETE, completion); // Older retransmission cannot regress totals.
  assert.equal(h.snapshot().events.find(row => row.kind === 'usage').label, event.label);
  for (let i = 0; i < 45; i++) h.emit('message_end', { message: { role: 'assistant' } });
  h.pi.events.emit(CHILD_COMPLETE, newer); h.tick();
  assert.equal(h.snapshot().events.length, 40); assert.ok(!h.snapshot().events.some(row => row.kind === 'usage'), 'Evicted usage resurrected');
  h.reply(asyncData([])); assert.equal(h.snapshot().nodes.length, 1);
  h.emit('session_shutdown'); assert.equal(h.listeners.size, 0);
});

test('early completions wait for exact subagent-root identity; foreign, workflow and malformed evidence stays unlinked', () => {
  const h = harness(); h.emit('session_start');
  const rejects = [ { sessionId: 'pi-id' }, { sessionId: '/other/session' }, { lifecycleArtifactVersion: 2 },
    { mode: 'workflow' }, { mode: 'parallel' }, { mode: 'chain' }, { state: 'paused' }, { state: 'running' },
    { id: 'other-run' }, { runId: '' }, { timestamp: -1 }, { timestamp: Infinity }, { awaitedByWorkflow: true },
    { parentWorkflowRunId: 'workflow' }, { workflowKey: 'lane' }, { results: [] }, { results: [{}, {}] },
    { results: [{ skipped: true }] }, { results: [{ workflowKey: 'lane' }] }, { results: [{ runId: 'different' }] } ];
  for (const fields of rejects) h.pi.events.emit(CHILD_COMPLETE, childCompletion(h, fields));
  h.reply(singleRun());
  assert.ok(!h.snapshot().events.some(row => row.kind === 'usage')); assert.equal(h.snapshot().nodes[1].model, undefined);
  h.pi.events.emit(CHILD_COMPLETE, childCompletion(h, { runId: 'unobserved', id: 'unobserved' }));
  assert.equal(h.snapshot().nodes.length, 3); assert.ok(!h.snapshot().events.some(row => row.kind === 'usage'));
  h.emit('session_shutdown');
  const early = harness(); early.emit('session_start');
  early.pi.events.emit(CHILD_COMPLETE, childCompletion(early));
  assert.equal(early.snapshot().nodes.length, 1); assert.ok(!early.snapshot().events.some(row => row.kind === 'usage'));
  early.reply(singleRun());
  assert.equal(early.snapshot().events.find(row => row.kind === 'usage').nodeId, early.snapshot().nodes[1].id);
  early.emit('session_shutdown');
  for (const kind of ['workflow', 'step', 'host-step', 'unknown']) {
    const other = harness(); other.emit('session_start');
    other.pi.events.emit(CHILD_COMPLETE, childCompletion(other));
    other.reply(asyncData([{ id: 'run', kind, state: 'complete' }]));
    assert.ok(!other.snapshot().events.some(row => row.kind === 'usage'), `Attributed usage to ${kind}`);
    other.emit('session_shutdown');
  }
});

test('completion never joins same-name agents or opaque fleet keys by label, index or spelling', () => {
  const h = harness(); h.emit('session_start');
  const data = singleRun(); data.asyncSnapshot.omitted = { children: 0 };
  data.asyncSnapshot.runs.unshift({ id: 'other-run', kind: 'subagent', label: 'trainee', state: 'complete' });
  data.fleet = { version: 1, entries: [{ key: 'run', agent: 'trainee', model: 'provider/unlinked', tokens: { window: 9876 } }] };
  h.reply(data); h.pi.events.emit(CHILD_COMPLETE, childCompletion(h));
  const snapshot = h.snapshot(), [other, exact, fleet] = snapshot.nodes.slice(1);
  assert.equal(other.model, undefined); assert.equal(exact.model, 'provider/child');
  assert.equal(fleet.model, 'provider/unlinked'); assert.equal(fleet.parentId, null);
  assert.equal(exact.lastInputTokens, undefined); assert.equal(fleet.lastInputTokens, 9876);
  assert.equal(snapshot.events.find(row => row.kind === 'usage').nodeId, exact.id);
  h.emit('session_shutdown');
});

test('completion evidence is count/age bounded and reset by owner generation without raw-payload retention', () => {
  const h = harness(); h.emit('session_start');
  for (let i = 0; i < 200; i++) h.pi.events.emit(CHILD_COMPLETE, childCompletion(h, { runId: `run-${i}`, id: `run-${i}`, summary: 'SECRET'.repeat(1000) }));
  h.reply(asyncData([{ id: 'run-0', kind: 'subagent', state: 'complete' }]));
  assert.equal(h.snapshot().nodes[1].model, undefined, 'Old pending fact survived the count bound');
  h.tick(); h.reply(asyncData([{ id: 'run-199', kind: 'subagent', state: 'complete' }]));
  assert.equal(h.snapshot().nodes[1].model, 'provider/child'); assert.ok(!JSON.stringify(h.snapshot()).includes('SECRET'));
  const stale = h.listeners.get(CHILD_COMPLETE);
  h.emit('session_start'); const writes = h.writes.length;
  stale(childCompletion(h)); assert.equal(h.writes.length, writes, 'Stale generation callback published');
  h.pi.events.emit(CHILD_COMPLETE, childCompletion(h));
  h.tick(5 * 60 * 1000 + 1); h.reply(singleRun());
  assert.equal(h.snapshot().nodes[1].model, undefined, 'Expired pending completion acquired a node');
  assert.ok(!h.snapshot().events.some(row => row.kind === 'usage'));
  h.emit('session_shutdown'); const stopped = h.writes.length;
  stale(childCompletion(h)); assert.equal(h.writes.length, stopped); assert.equal(h.listeners.size, 0);
});

test('failed and unknown child run usage is reported honestly, never as free work or context occupancy', () => {
  for (const usage of [undefined, {}, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, { input: -1, output: NaN }]) {
    const h = harness(); h.emit('session_start'); h.reply(singleRun());
    h.pi.events.emit(CHILD_COMPLETE, childCompletion(h, { state: 'failed', results: [{ model: 'https://SECRET/key', usage }] }));
    const snapshot = h.snapshot();
    assert.equal(snapshot.events.find(row => row.kind === 'usage').label, 'Reported run total (failed) · usage not reported');
    assert.equal(snapshot.nodes[1].model, undefined); assert.equal(snapshot.nodes[1].state, 'complete', 'Usage guessed lifecycle');
    assert.equal(snapshot.nodes[1].context, undefined); assert.ok(!JSON.stringify(snapshot).includes('SECRET'));
    h.emit('session_shutdown');
  }
  const h = harness(); h.emit('session_start'); h.reply(singleRun());
  h.pi.events.emit(CHILD_COMPLETE, childCompletion(h, { results: [{ usage: { output: 12, input: Infinity, cacheRead: 0 } }] }));
  assert.equal(h.snapshot().events.find(row => row.kind === 'usage').label, 'Reported run total · cached 0 · in ? · out 12 · write ?');
  h.emit('session_shutdown');
});

test('atomic replacement leaves old open inode and new pathname complete; private mode and no temp remnants', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'activity-bridge-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, '.activity.json');
  writeAtomicSnapshot(path, { version: 1, old: true });
  const fd = openSync(path, 'r');
  try {
    writeAtomicSnapshot(path, { version: 1, new: true });
    assert.deepEqual(JSON.parse(readFileSync(fd, 'utf8')), { version: 1, old: true });
    assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')), { version: 1, new: true });
  } finally { closeSync(fd); }
  assert.equal(statSync(path).mode & 0o777, 0o600);
  assert.deepEqual(readdirSync(dir), ['.activity.json']);
  const blocked = join(dir, 'directory'); mkdirSync(blocked);
  assert.throws(() => writeAtomicSnapshot(blocked, { version: 1 }));
  assert.deepEqual(readdirSync(dir).sort(), ['.activity.json', 'directory']);
});

test('extension writes complete real JSON, while filesystem failures cannot interrupt tools', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'activity-bridge-runtime-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, '.activity.json');
  const h = harness({ env: { ...env, LIMILINK_ACTIVITY_PATH: path }, write: writeAtomicSnapshot });
  h.emit('session_start'); h.emit('agent_start');
  h.emit('tool_execution_start', { toolCallId: 'x', toolName: 'read' });
  h.emit('message_end', { message: { role: 'assistant', stopReason: 'toolUse', usage: { input: 5, output: 2, cacheRead: 100, cacheWrite: 0 } } });
  const s = JSON.parse(readFileSync(path, 'utf8'));
  assert.equal(s.version, 1); assert.equal(s.state, 'working'); assert.equal(s.tools[0].name, 'read');
  assert.equal(s.events.at(-1).kind, 'model');
  assert.equal(s.events.at(-1).label, 'Model · cached 100 · in 5 · out 2');
  h.emit('session_shutdown'); assert.equal(JSON.parse(readFileSync(path, 'utf8')).state, 'stopped');
  const broken = harness({ write() { throw Error('disk unavailable'); } });
  assert.doesNotThrow(() => { broken.emit('session_start'); broken.emit('agent_start'); broken.emit('session_shutdown'); });
  assert.equal(broken.timers.size, 0);
});

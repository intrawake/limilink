import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, statSync, openSync, closeSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { contextUsage, installActivityBridge, mapSubagents, writeAtomicSnapshot } from '../tool/activity-bridge.mjs';

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

test('compaction invalidates context through polls and settlement until fresh successful assistant response', () => {
  const h = harness(); h.emit('session_start');
  assert.equal(h.snapshot().context.tokens, 20);
  h.emit('session_compact', { compactionEntry: { summary: 'private summary' } });
  assert.equal(h.snapshot().context, null); assert.equal(h.snapshot().nodes[0].context, undefined);
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
  assert.equal(h.listeners.size, 0);
  h.emit('session_shutdown');
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
  assert.equal(h.snapshot().subagentsAvailable, false); assert.equal(h.listeners.size, 1);
  h.tick(1000); assert.equal(h.requests.length, 1);
  const expired = h.requests[0]; h.tick(5000);
  assert.equal(h.requests.length, 2); assert.equal(h.listeners.size, 1);
  h.reply(asyncData([]), expired); assert.equal(h.snapshot().subagentsAvailable, false);
  h.reply(asyncData([]), h.requests.at(-1), { success: false, error: { message: 'private error' } });
  assert.equal(h.snapshot().subagentsAvailable, false); assert.equal(h.listeners.size, 0);
  h.tick(); const pending = h.requests.at(-1);
  h.emit('session_shutdown');
  assert.equal(h.snapshot().state, 'idle'); assert.equal(h.timers.size, 0); assert.equal(h.listeners.size, 0);
  const n = h.writes.length;
  h.reply(asyncData([]), pending); h.tick(); h.emit('session_shutdown');
  assert.equal(h.writes.length, n);
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
  const s = JSON.parse(readFileSync(path, 'utf8'));
  assert.equal(s.version, 1); assert.equal(s.state, 'working'); assert.equal(s.tools[0].name, 'read');
  h.emit('session_shutdown'); assert.equal(JSON.parse(readFileSync(path, 'utf8')).state, 'stopped');
  const broken = harness({ write() { throw Error('disk unavailable'); } });
  assert.doesNotThrow(() => { broken.emit('session_start'); broken.emit('agent_start'); broken.emit('session_shutdown'); });
  assert.equal(broken.timers.size, 0);
});

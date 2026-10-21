import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, readdirSync, rmSync, unlinkSync, symlinkSync, chmodSync, statSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { CHILD_LIMIT, installChildObserver, slotName } from '../tool/activity-child.mjs';
import { createSessionStore, createSessionTracking, readPrivateJSON, sessionEventTail } from '../tool/activity-sessions.mjs';
import { keyedIdFor } from '../tool/activity-metadata.mjs';
import { installActivityBridge } from '../tool/activity-bridge.mjs';

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'activity-sessions-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const token = randomUUID(), parentFile = '/PRIVATE-parent/session.jsonl', parentUUID = 'parent-sdk-uuid';
  const config = { directory, token, rootKey: keyedIdFor(token, 'session', parentFile, parentUUID), rootFileKey: keyedIdFor(token, 'file', parentFile) };
  let clock = 1700000000000;
  const store = createSessionStore(config, { now: () => clock });
  const runtimes = [];
  const runtime = (file = '/PRIVATE-child/session.jsonl', uuid = 'child-sdk-uuid', parent = parentFile, extra = {}) => {
    const handlers = new Map(), timers = new Map();
    const ctx = { file, uuid, parent, model: { id: 'selected/model' },
      sessionManager: { getSessionFile: () => ctx.file, getSessionId: () => ctx.uuid, getHeader: () => ({ parentSession: ctx.parent }),
        getEntries() { throw new Error('Journals forbidden'); }, getBranch() { throw new Error('Journals forbidden'); } },
      getContextUsage: () => ({ tokens: 30, contextWindow: 100, percent: 30 }) };
    const pi = { on(event, handler) { handlers.set(event, handler); return () => handlers.delete(event); } };
    installChildObserver(pi, config, { now: () => clock, setInterval(fn) { const id = Symbol(); timers.set(id, fn); return id; }, clearInterval(id) { timers.delete(id); }, ...extra });
    const api = { ctx, handlers, timers, emit(event, data = {}) { handlers.get(event)?.(data, ctx); } };
    runtimes.push(api); return api;
  };
  return { config, store, runtime, runtimes, directory, parentFile, parentUUID,
    advance(ms = 1000, heartbeat = false) { clock += ms; if (heartbeat) for (const runtime of runtimes) for (const fn of runtime.timers.values()) fn(); },
    project(max = 63) { return store.project(max); },
    source(slot = 0) { return JSON.parse(readFileSync(join(directory, slotName(slot)), 'utf8')); },
    replace(source, slot = 0) { writeFileSync(join(directory, slotName(slot)), JSON.stringify(source), { mode: 0o600 }); },
  };
}
const poison = object => Object.defineProperties(object, Object.fromEntries(['content', 'args', 'result', 'details', 'images'].map(field => [field, { get() { throw new Error(`Forbidden ${field}`); } }])));
const message = (model = 'actual/model', usage = { input: 12, output: 7, cacheRead: 18, cacheWrite: 0 }, stopReason = 'stop') => poison({ role: 'assistant', model, usage, stopReason });
const response = (runtime, value = message()) => { runtime.emit('message_start', { message: value }); runtime.emit('message_end', { message: value }); };

test('child factory is inert; exact SDK file+UUID identity and metadata-only ancestry', t => {
  const f = fixture(t), r = f.runtime();
  assert.equal(readdirSync(f.directory).length, 0); assert.equal(r.timers.size, 0);
  r.emit('session_start');
  const p = f.project();
  assert.equal(p.nodes.length, 1); assert.equal(p.nodes[0].parentId, 'parent');
  assert.equal(p.edges[0].kind, 'ancestry'); assert.match(p.edges[0].label, /historical/);
  assert.equal(p.nodes[0].observation.modelBasis, 'selected');
  assert.equal(p.nodes[0].context, undefined, 'No inherited startup occupancy');
  assert.equal(r.timers.size, 1);
  assert.ok(!JSON.stringify(p).includes('PRIVATE')); assert.ok(!JSON.stringify(p).includes(f.config.token));
  assert.equal(statSync(join(f.directory, slotName(0))).mode & 0o777, 0o600);
  r.emit('session_shutdown'); assert.equal(r.timers.size, 0);
  f.advance(); assert.equal(f.project().nodes[0].state, 'closed');
});

test('no parent/file/UUID identity means unsupported, not a guessed root link', t => {
  const f = fixture(t);
  for (const [file, uuid, parent] of [['relative', 'id', f.parentFile], ['/child', '', f.parentFile], ['/child', 'id', undefined], ['/child', 'id', '/child']]) {
    const r = f.runtime(file, uuid, parent); if (parent === undefined) r.ctx.parent = undefined;
    r.emit('session_start'); assert.equal(r.timers.size, 0);
  }
  assert.equal(f.project().nodes.length, 0);
});

test('response lifecycle pairs only; own model/nullable usage, no body/args/result getters', t => {
  const f = fixture(t), r = f.runtime(); r.emit('session_start');
  r.emit('message_end', { message: message('inherited/model') });
  assert.equal(f.source().records.some(row => row.kind === 'model'), false);
  r.emit('agent_start'); response(r); r.emit('agent_end');
  const p = f.project(), node = p.nodes[0];
  assert.equal(node.model, 'actual/model'); assert.equal(node.observation.modelBasis, 'response');
  assert.equal(node.observation.selectedModel, 'selected/model'); assert.equal(node.lastInputTokens, 30);
  assert.equal(node.context, undefined, 'Selected-model capacity is not assigned to a routed response model'); assert.equal(node.observation.lastInputObservedAt, 1700000000000);
  assert.match(p.events.find(row => row.kind === 'model').label, /Response actual\/model · cached 18 · in 12 · out 7/);
  f.advance(); response(r, message('second/model', { input: 2, output: null, cacheRead: 0, cacheWrite: null }));
  const labels = f.project().events.filter(row => row.kind === 'model').map(row => row.label);
  assert.match(labels[0], /actual\/model/); assert.match(labels[1], /second\/model.*out \?.*write \?/);
});

test('compaction/model selection/new observer invalidate measurements, not historical input', t => {
  const f = fixture(t), r = f.runtime(); r.ctx.model.id = 'actual/model'; r.emit('session_start'); response(r); r.emit('agent_end');
  f.advance(); r.emit('session_compact');
  let n = f.project().nodes[0]; assert.equal(n.context, undefined); assert.equal(n.lastInputTokens, 30); assert.equal(n.observation.invalidated, 'compaction');
  f.advance(); response(r, message('failed/model', { input: 300, output: 1, cacheRead: 2, cacheWrite: 0 }, 'error')); r.emit('agent_end');
  n = f.project().nodes[0]; assert.equal(n.observation.invalidated, 'compaction'); assert.equal(n.lastInputTokens, 30);
  f.advance(); response(r); r.emit('agent_end'); assert.ok(f.project().nodes[0].context);
  f.advance(); r.emit('model_select', { model: { id: 'new/selection' } });
  n = f.project().nodes[0]; assert.equal(n.context, undefined); assert.equal(n.model, 'actual/model'); assert.equal(n.observation.selectedModel, 'new/selection');
  r.emit('session_shutdown');
  const next = f.runtime(); next.emit('session_start'); f.advance();
  n = f.project().nodes[0]; assert.equal(n.context, undefined); assert.equal(n.lastInputTokens, 30);
});

test('all-zero, invalid, aborted and incomplete responses never invent fresh known input', t => {
  const f = fixture(t), r = f.runtime(); r.emit('session_start');
  response(r, message('zero/model', { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }));
  assert.equal(f.source().lastInput, undefined);
  assert.match(f.project().events.find(row => row.kind === 'model').label, /usage not reported/);
  response(r, message('bad/model', { input: -1, output: 3, cacheRead: Infinity, cacheWrite: 0 }));
  response(r, message('aborted/model', { input: 10, output: 2, cacheRead: 2, cacheWrite: 0 }, 'aborted'));
  assert.equal(f.source().lastInput, undefined);
  r.emit('message_start', { message: { role: 'assistant' } }); r.emit('session_shutdown');
  assert.ok(f.source().omitted >= 1);
});

test('tools coalesce with explicit nesting, stable starts, same-name parallel IDs and own termination', t => {
  const f = fixture(t), r = f.runtime(); r.emit('session_start');
  r.emit('tool_execution_start', poison({ toolCallId: 'outer', toolName: 'codemode' }));
  r.emit('tool_execution_start', poison({ toolCallId: 'one', toolName: 'read', parentToolCallId: 'outer' }));
  r.emit('tool_execution_start', poison({ toolCallId: 'two', toolName: 'read' }));
  const before = f.project().events.filter(row => row.kind === 'tool');
  assert.equal(before.length, 3); assert.equal(before[1].parentEventId, before[0].id);
  f.advance(); r.emit('tool_execution_end', poison({ toolCallId: 'one', toolName: 'read', durationMs: 14, isError: false }));
  r.emit('tool_execution_start', poison({ toolCallId: 'one', toolName: 'read' }));
  const after = f.project().events.filter(row => row.kind === 'tool');
  assert.equal(after[1].at, before[1].at); assert.equal(after[1].state, 'finished'); assert.equal(after[1].label, 'Finished read · 14ms');
  r.emit('session_shutdown'); f.advance();
  const terminal = f.project().events.filter(row => row.kind === 'tool');
  assert.deepEqual(terminal.map(row => row.state), ['unknown', 'finished', 'unknown']);
});

test('recently evicted terminal tools cannot replay; unknown outcomes refine only with owning evidence', t => {
  const f = fixture(t), r = f.runtime(); r.emit('session_start');
  r.emit('tool_execution_start', { toolCallId: 'past', toolName: 'read' });
  r.emit('tool_execution_end', { toolCallId: 'past', toolName: 'read', isError: false });
  for (let i = 0; i < 20; i++) response(r, message(`model/${i}`));
  r.emit('tool_execution_start', { toolCallId: 'past', toolName: 'read' });
  assert.equal(f.source().records.some(row => row.kind === 'tool'), false);
  r.emit('tool_execution_start', { toolCallId: 'pending', toolName: 'bash' }); r.emit('agent_end');
  assert.equal(f.source().records.at(-1).state, 'unknown');
  r.emit('tool_execution_end', { toolCallId: 'pending', toolName: 'bash', isError: true, durationMs: 9 });
  assert.equal(f.source().records.at(-1).state, 'failed');
  r.emit('tool_execution_end', { toolCallId: 'pending', toolName: 'bash', isError: false });
  assert.equal(f.source().records.at(-1).state, 'failed');
});

test('heartbeat never republishes a changed/missing SDK identity as freshly observed', t => {
  const f = fixture(t), r = f.runtime(); r.emit('session_start');
  r.ctx.uuid = 'changed-without-startup'; f.advance(2000, true);
  assert.equal(r.timers.size, 0); assert.equal(f.source().state, 'closed');
  const next = f.runtime('/second', 'second'); next.emit('session_start'); next.ctx.file = undefined; next.emit('agent_start');
  assert.equal(next.timers.size, 0); assert.equal(f.source(1).state, 'closed');
});

test('response model retains provider identity without reading payloads', t => {
  const f = fixture(t), r = f.runtime(); r.emit('session_start');
  response(r, { ...message('shared-id'), provider: 'route-one' });
  f.advance(); response(r, { ...message('shared-id'), provider: 'route-two' });
  const p = f.project(); assert.equal(p.nodes[0].model, 'route-two/shared-id');
  assert.ok(p.events.some(row => row.label.includes('route-one/shared-id')));
  assert.ok(p.events.some(row => row.label.includes('route-two/shared-id')));
});

test('same-revision mutated frames cannot replace evidence or refresh timestamps', t => {
  const f = fixture(t), r = f.runtime(); r.emit('session_start'); const before = f.project();
  const source = f.source(); source.selectedModel = 'injected/new'; source.updatedAt += 1; f.replace(source);
  f.advance(); const after = f.project(); assert.equal(after.limited, true);
  assert.equal(after.nodes[0].model, before.nodes[0].model); assert.equal(after.nodes[0].updatedAt, before.nodes[0].updatedAt);
});

test('parallel collectors isolate states and IDs; missing outcomes stay live until owning evidence', t => {
  const f = fixture(t), a = f.runtime('/a', 'a'), b = f.runtime('/b', 'b');
  a.emit('session_start'); b.emit('session_start');
  for (const r of [a, b]) r.emit('tool_execution_start', { toolCallId: 'same', toolName: 'read' });
  const initial = f.project(); assert.equal(new Set(initial.events.filter(row => row.kind === 'tool').map(row => row.id)).size, 2);
  a.emit('session_shutdown'); f.advance();
  const p = f.project();
  assert.deepEqual(p.events.filter(row => row.kind === 'tool').map(row => row.state), ['unknown', 'running']);
});

test('nested header file refs link only observed ancestors; missing ancestors stay disconnected', t => {
  const f = fixture(t), parent = f.runtime('/a', 'a'), nested = f.runtime('/b', 'b', '/a'), orphan = f.runtime('/c', 'c', '/unobserved');
  parent.emit('session_start'); nested.emit('session_start'); orphan.emit('session_start');
  const p = f.project(); assert.equal(p.nodes.find(n => n.id === keyedIdFor(f.config.token, 'session', '/b', 'b')).parentId,
    p.nodes.find(n => n.id === keyedIdFor(f.config.token, 'session', '/a', 'a')).id);
  assert.equal(p.nodes.find(n => n.id === keyedIdFor(f.config.token, 'session', '/c', 'c')).parentId, null);
  assert.equal(p.edges.length, 2);
});

test('same path with distinct UUIDs does not merge history and makes incoming ancestry ambiguous', t => {
  const f = fixture(t), a = f.runtime('/same', 'old'), b = f.runtime('/same', 'new'), child = f.runtime('/descendant', 'c', '/same');
  a.emit('session_start'); response(a, message('old/model')); a.emit('session_shutdown');
  b.emit('session_start'); response(b, message('new/model')); child.emit('session_start');
  const p = f.project(); assert.equal(p.nodes.length, 3);
  const target = p.nodes.find(node => node.id === keyedIdFor(f.config.token, 'session', '/descendant', 'c'));
  assert.equal(target.parentId, null); assert.equal(target.observation.ancestry, 'ambiguous');
  assert.equal(new Set(p.events.filter(row => row.kind === 'model').map(row => row.nodeId)).size, 2);
});

test('unclosed observer conflicts cannot be resolved by heartbeat age or newer instance', t => {
  const f = fixture(t), a = f.runtime(), b = f.runtime(); a.ctx.model.id = 'actual/model'; b.ctx.model.id = 'actual/model';
  a.emit('session_start'); response(a); a.emit('agent_end'); assert.ok(f.project().nodes[0].context);
  f.advance(20000); b.emit('session_start'); response(b); b.emit('agent_end');
  const n = f.project().nodes[0]; assert.equal(n.observation.status, 'conflict'); assert.equal(n.context, undefined); assert.equal(n.parentId, 'parent');
  // Same historical header reference is valid even when current liveness conflicts.
  assert.equal(n.state, 'unknown');
});

test('silence/omission never proves termination; heartbeat preserves actual capture freshness', t => {
  const f = fixture(t), r = f.runtime(); r.emit('session_start'); r.emit('tool_execution_start', { toolCallId: 'open', toolName: 'bash' });
  const sourceAt = f.source().updatedAt; f.advance(15000);
  const stale = f.project(); assert.equal(stale.nodes[0].observation.status, 'stale'); assert.equal(stale.nodes[0].updatedAt, sourceAt);
  assert.equal(stale.events.find(row => row.kind === 'tool').state, 'running');
  unlinkSync(join(f.directory, slotName(0))); f.advance(); assert.equal(f.project().nodes[0].observation.status, 'stale');
  f.advance(1000, true); assert.equal(f.project().nodes[0].observation.status, 'open');
});

test('changed context identity closes its observation, never mutates an existing instance tuple', t => {
  const f = fixture(t), r = f.runtime(); r.emit('session_start'); r.ctx.uuid = 'replacement'; r.emit('agent_start');
  const p = f.project(); assert.equal(p.nodes.length, 2); assert.equal(p.nodes[0].state, 'closed');
  assert.notEqual(p.nodes[0].id, p.nodes[1].id);
});

test('conflicting parent claims and cycles do not fabricate ancestry', t => {
  const f = fixture(t), a = f.runtime('/a', 'a', '/b'), b = f.runtime('/b', 'b', '/a');
  a.emit('session_start'); b.emit('session_start');
  assert.equal(f.project().edges.length, 0);
  assert.ok(f.project().nodes.every(n => n.observation.ancestry === 'ambiguous'));
  const duplicate = f.runtime('/a', 'a', f.parentFile); duplicate.emit('session_start'); f.advance();
  assert.equal(f.project().nodes.find(n => n.id === keyedIdFor(f.config.token, 'session', '/a', 'a')).parentId, null);
});

test('metadata parser reconstructs labels, rejects foreign/tampered/replayed sources and never follows links', t => {
  const f = fixture(t), r = f.runtime(); r.emit('session_start'); response(r); const original = f.source();
  const forged = structuredClone(original); forged.records[0].label = 'PRIVATE injected prose'; forged.records.push({ id: 'child-event:' + '1'.repeat(32), at: 1, kind: 'model', label: 'PRIVATE', usage: {}, model: '/PRIVATE/path' });
  forged.revision++; f.replace(forged); const p = f.project(); assert.ok(!JSON.stringify(p).includes('PRIVATE'));
  f.advance(); const older = { ...original, revision: 0, state: 'working' }; f.replace(older); assert.ok(f.project().limited);
  f.advance(); f.replace({ ...original, token: randomUUID() }); assert.ok(f.project().limited);
  unlinkSync(join(f.directory, slotName(0))); symlinkSync('/etc/passwd', join(f.directory, slotName(0))); f.advance(); assert.ok(f.project().limited);
  assert.throws(() => readPrivateJSON(join(f.directory, slotName(0)), 4096));
});

test('per-source bytes/history, disk slots, retained map and rendered graph are bounded', t => {
  const f = fixture(t), r = f.runtime(); r.emit('session_start');
  for (let i = 0; i < 80; i++) response(r, message(`model/${i}`));
  assert.ok(readFileSync(join(f.directory, slotName(0))).length <= CHILD_LIMIT.bytes);
  assert.ok(f.source().records.length <= 12); assert.ok(f.source().omitted > 0);
  for (let i = 1; i < CHILD_LIMIT.instances; i++) f.runtime(`/s/${i}`, `uuid-${i}`).emit('session_start');
  const extra = f.runtime('/over-budget', 'overflow'); extra.emit('session_start'); assert.equal(extra.timers.size, 0);
  const p = f.project(8); assert.equal(p.nodes.length, 8); assert.equal(p.limited, true);
  assert.equal(readdirSync(f.directory).filter(file => file.startsWith('slot-')).length, CHILD_LIMIT.instances);
});

test('fixed slot temp names bound crash remnants and reclaim only a newly admitted slot', t => {
  const f = fixture(t), temp = join(f.directory, `${slotName(0)}.tmp`);
  writeFileSync(temp, 'old crash remnant', { mode: 0o600 });
  const r = f.runtime(); r.emit('session_start');
  assert.equal(existsSync(temp), false); assert.equal(f.source().state, 'idle');
  r.emit('agent_start'); r.emit('session_shutdown');
  assert.equal(readdirSync(f.directory).filter(file => file.endsWith('.tmp')).length, 0);
});

test('closed slots can be reclaimed, never open stale slots; omitted nodes do not replay new timestamps', t => {
  const f = fixture(t), r = f.runtime(); r.emit('session_start'); response(r); r.emit('session_shutdown');
  const events = f.project().events; f.advance(6 * 60 * 1000); f.project();
  assert.equal(existsSync(join(f.directory, slotName(0))), false);
  assert.deepEqual(f.project(0).events, []); assert.deepEqual(f.project().events, events);
  const open = f.runtime('/open', 'open'); open.emit('session_start'); f.advance(6 * 60 * 1000); f.project();
  assert.equal(existsSync(join(f.directory, slotName(0))), true);
});

test('per-owner fair admission protects quiet session history from a busy sibling/main', () => {
  const rows = owner => Array.from({ length: 40 }, (_, at) => ({ id: `${owner}-${at}`, nodeId: owner, at }));
  const p = sessionEventTail(rows('parent'), [...rows('busy'), { id: 'quiet', nodeId: 'quiet', at: 1 }]);
  assert.equal(p.length, 40); assert.ok(p.some(row => row.id === 'quiet'));
  assert.equal(new Set(p.map(row => row.id)).size, p.length);
});

test('registration uses public UUID, preserves bootstrap/owner and declines a changed root or existing policy', async t => {
  const f = fixture(t); let captured, disposed = 0;
  const ctx = { sessionManager: { getSessionFile: () => f.parentFile, getSessionId: () => f.parentUUID } };
  const setup = () => createSessionTracking(ctx, join(f.directory, '.activity.json'), { register: input => { captured = input; return { dispose() { disposed++; } }; } });
  const tracker = await setup(); assert.ok(tracker); assert.equal(captured.sessionId, f.parentUUID); assert.equal(captured.requireForAllRunners, undefined);
  const bootstrap = captured.extensions[0].path, code = readFileSync(bootstrap, 'utf8'); assert.match(code, /try.*await import/);
  tracker.dispose(); tracker.dispose(); assert.equal(disposed, 1); assert.equal(readFileSync(bootstrap, 'utf8'), code);
  const again = await setup(); assert.ok(again); assert.equal(readFileSync(bootstrap, 'utf8'), code); again.dispose();
  ctx.sessionManager.getSessionId = () => 'different-root'; assert.equal(await setup(), null); assert.equal(readFileSync(bootstrap, 'utf8'), code);
  ctx.sessionManager.getSessionId = () => f.parentUUID;
  assert.equal(await createSessionTracking(ctx, join(f.directory, '.activity.json'), { register() { throw new Error('Other owner'); } }), null);
});

test('unsafe directory/modes and partial observer installation fail softly', t => {
  const f = fixture(t); chmodSync(f.directory, 0o755);
  const r = f.runtime(); r.emit('session_start'); assert.equal(r.timers.size, 0);
  assert.doesNotThrow(() => f.project()); assert.equal(f.project().limited, true);
  chmodSync(f.directory, 0o700);
  let count = 0, removed = 0;
  installChildObserver({ on() { if (++count === 4) throw new Error('Unsupported'); return () => removed++; } }, f.config);
  assert.equal(removed, 3);
});

test('parent bridge keeps session records separate from native runs; parent settlement cannot close a child', async () => {
  const handlers = new Map(), listeners = new Map(), writes = [], timers = new Map(); let disposed = 0;
  const native = { id: 'native-run', kind: 'subagent', state: 'running', label: 'role-name', children: [] };
  const child = { id: 'session:' + 'a'.repeat(32), parentId: 'parent', label: 'Child session aaaaaaaa', kind: 'agent', state: 'working', observation: { basis: 'pi-session-events', status: 'open', observedAt: 1, omitted: 0, ancestry: 'file-reference' } };
  const childEvent = { id: 'owned-child-event', nodeId: child.id, at: 1, kind: 'tool', state: 'running', label: 'Running read' };
  const ctx = { cwd: '/session', model: { id: 'main-model' }, isIdle: () => true, getContextUsage: () => undefined,
    sessionManager: { getSessionFile: () => '/session/sessions/main.jsonl', getSessionId: () => 'main-uuid', getHeader: () => ({}) } };
  const pi = { on(event, handler) { handlers.set(event, handler); }, events: {
    on(event, handler) { listeners.set(event, handler); return () => listeners.delete(event); },
    emit(event, request) { if (event === 'subagents:rpc:v1:request') listeners.get(`subagents:rpc:v1:reply:${request.requestId}`)?.({ version: 1, requestId: request.requestId, success: true, data: { asyncSnapshot: { version: 1, kind: 'pi-subagents.async-status-snapshot', runs: [native] } } }); },
  } };
  installActivityBridge(pi, { env: { LIMILINK_ACTIVITY_PATH: '/session/.activity.json', LIMILINK_ACTIVITY_OWNER_CWD: '/session', LIMILINK_ACTIVITY_SESSION_DIR: '/session/sessions', LIMILINK_ACTIVITY_CHILD_SESSIONS: '1' },
    now: () => 10, write(_path, snapshot) { writes.push(structuredClone(snapshot)); }, setInterval(fn) { timers.set(1, fn); return 1; }, clearInterval(id) { timers.delete(id); },
    createSessionTracking: async () => ({ project: () => ({ nodes: [structuredClone(child)], edges: [], events: [structuredClone(childEvent)], limited: false }), dispose() { disposed++; } }),
  });
  await handlers.get('session_start')({}, ctx);
  assert.equal(writes.at(-1).nodes.length, 3); assert.equal(writes.at(-1).sessionTracking.available, true);
  handlers.get('agent_settled')({ aborted: false }, ctx);
  assert.equal(writes.at(-1).events.find(row => row.nodeId === child.id).state, 'running');
  handlers.get('session_shutdown')({}, ctx); assert.equal(disposed, 1);
  assert.equal(timers.size, 0);
});

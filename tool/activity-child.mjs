/** Child-only Pi extension implementation. Native events -> bounded metadata.
 * No prompts, journals, tool arguments/results, process-global session state,
 * provider calls, registration of tools, or writes to the parent snapshot.
 */
import { randomUUID } from 'node:crypto';
import { lstatSync, openSync, closeSync, unlinkSync, writeFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { contextUsage, idFor, keyedIdFor, key, observedModel, name, safeCount, usageLabel, writeAtomicSnapshot } from './activity-metadata.mjs';

export const CHILD_LIMIT = Object.freeze({ records: 12, bytes: 4096, tools: 64, instances: 128, heartbeatMs: 2000, staleMs: 10000 });
export const slotName = slot => `slot-${String(slot).padStart(3, '0')}.json`;
export const fileKey = value => typeof value === 'string' && /^file:[0-9a-f]{32}$/.test(value);
export const instanceId = value => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value);
export const sessionKey = value => typeof value === 'string' && /^session:[0-9a-f]{32}$/.test(value);
export function privateDirectory(path) {
  const info = lstatSync(path);
  return info.isDirectory() && info.uid === process.getuid() && (info.mode & 0o077) === 0;
}
const increment = value => Math.min(Number.MAX_SAFE_INTEGER, value + 1);

export function installChildObserver(pi, config, options = {}) {
  if (!config || !isAbsolute(config.directory ?? '') || !instanceId(config.token) || !sessionKey(config.rootKey) || !fileKey(config.rootFileKey)) return;
  const now = options.now ?? Date.now, write = options.write ?? ((path, data) => writeAtomicSnapshot(path, data, `${path}.tmp`));
  const schedule = options.setInterval ?? setInterval, unschedule = options.clearInterval ?? clearInterval;
  let ctx, identity, instance, slot, timer, sequence = 0, revision = 0, omitted = 0, pendingResponse = false;
  const subscriptions = [];
  const listen = (event, handler) => { const off = pi.on(event, handler); if (typeof off === 'function') subscriptions.push(off); };
  let state = 'idle', selectedModel = null, responseModel = null, lastInput = null, context = null, invalidated = null, fresh = false;
  let records = [], tools = new Map(), seenTools = new Set();
  const identify = candidate => {
    const file = candidate?.sessionManager.getSessionFile(), parent = candidate?.sessionManager.getHeader()?.parentSession;
    const uuid = candidate?.sessionManager.getSessionId();
    if (!isAbsolute(file ?? '') || !isAbsolute(parent ?? '') || file === parent || !key(uuid)) return null;
    return { sessionKey: keyedIdFor(config.token, 'session', file, uuid), fileKey: keyedIdFor(config.token, 'file', file),
      uuidKey: keyedIdFor(config.token, 'uuid', uuid), parentKey: keyedIdFor(config.token, 'file', parent) };
  };
  const publish = () => {
    if (!identity || !instance) return;
    try {
      if (!options.write && !privateDirectory(config.directory)) return;
      revision = increment(revision);
      const snapshot = { version: 1, token: config.token, rootKey: config.rootKey, instance, ...identity,
        revision, updatedAt: now(), state, omitted, records,
        ...(selectedModel ? { selectedModel } : {}), ...(responseModel ? { responseModel } : {}),
        ...(lastInput ? { lastInput } : {}), ...(context ? { context } : {}), ...(invalidated ? { invalidated } : {}),
        ...(tools.size ? { currentTool: [...tools.values()].at(-1).name } : {}) };
      while (records.length && (records.length > CHILD_LIMIT.records || Buffer.byteLength(JSON.stringify(snapshot)) > CHILD_LIMIT.bytes)) {
        records.shift(); omitted = increment(omitted); snapshot.omitted = omitted;
      }
      write(join(config.directory, slotName(slot)), snapshot);
    } catch { /* Optional telemetry must not throw through Pi's handlers. */ }
  };
  const record = (kind, label, extra = {}) => {
    sequence = increment(sequence);
    const row = { id: idFor('child-event', instance, sequence), at: now(), kind, label: label.slice(0, 200), ...extra };
    records.push(row);
    return row;
  };
  const settle = () => {
    for (const row of records) if (row.kind === 'tool' && row.state === 'running') {
      row.state = 'unknown'; row.label = `Outcome not observed ${row.tool}`;
    }
    tools.clear();
    if (pendingResponse) { omitted = increment(omitted); pendingResponse = false; }
  };
  const close = () => {
    if (timer !== undefined) unschedule(timer);
    timer = undefined;
    if (!identity || state === 'closed') return;
    settle(); state = 'closed'; context = null; record('session', 'Session observer closed'); publish();
  };
  const start = candidate => {
    close();
    ctx = candidate; identity = identify(ctx);
    if (!identity || identity.sessionKey === config.rootKey) { identity = null; return; }
    instance = (options.randomUUID ?? randomUUID)();
    slot = undefined;
    if (options.write) slot = options.slot ?? 0;
    else {
      if (!privateDirectory(config.directory)) { identity = null; return; }
      for (let index = 0; index < CHILD_LIMIT.instances; index++) {
        try {
          const path = join(config.directory, slotName(index));
          const fd = openSync(path, 'wx', 0o600); closeSync(fd); slot = index;
          // Exclusive slot admission proves no other admitted collector owns its
          // fixed temp path; reclaim only that slot's possible crash remnant.
          try { unlinkSync(`${path}.tmp`); } catch { /* absent */ }
          break;
        }
        catch (error) { if (error.code !== 'EEXIST') { identity = null; return; } }
      }
      if (slot === undefined) {
        try { writeFileSync(join(config.directory, '.limited.json'), JSON.stringify({ version: 1, token: config.token, limited: true }), { mode: 0o600, flag: 'wx' }); } catch { /* one bounded omission marker, never a temp-file stream */ }
        identity = null; return;
      }
    }
    sequence = 0; revision = 0; omitted = 0; pendingResponse = false;
    records = []; tools = new Map(); seenTools = new Set(); state = 'idle'; fresh = false; invalidated = null; lastInput = null; context = null;
    selectedModel = observedModel(ctx.model); responseModel = null;
    record('session', 'Session observer started'); publish();
    timer = schedule(() => {
      try {
        const current = identify(ctx);
        if (!current || current.sessionKey !== identity?.sessionKey || current.parentKey !== identity?.parentKey) { close(); identity = null; return; }
        publish();
      } catch { close(); identity = null; }
    }, CHILD_LIMIT.heartbeatMs); timer?.unref?.();
  };
  const on = (event, handler) => listen(event, (data, candidate) => {
    try {
      if (!identity || state === 'closed') return;
      const next = identify(candidate);
      if (!next) { close(); identity = null; return; }
      if (next.sessionKey !== identity.sessionKey || next.parentKey !== identity.parentKey) start(candidate);
      ctx = candidate;
      if (identity) handler(data);
    } catch { /* No raw errors or control effects. */ }
  });
  try {
    listen('session_start', (_event, candidate) => { try { start(candidate); } catch { /* fail soft */ } });
    on('agent_start', () => { state = 'working'; fresh = false; record('agent', 'Session agent started'); publish(); });
    on('message_start', event => {
      if (event.message?.role !== 'assistant') return;
      if (pendingResponse) omitted = increment(omitted);
      pendingResponse = true;
    });
    on('message_end', event => {
      const message = event.message;
      if (message?.role !== 'assistant' || !pendingResponse) return;
      pendingResponse = false;
      const actualModel = observedModel(message);
      const status = message.stopReason === 'error' ? ' (error)' : message.stopReason === 'aborted' ? ' (aborted)' : '';
      const label = usageLabel(message.usage, `Response${actualModel ? ` ${actualModel.slice(0, 96)}` : ''}${status}`);
      record('model', label, { ...(actualModel ? { model: actualModel } : {}),
        stopReason: message.stopReason === 'error' ? 'error' : message.stopReason === 'aborted' ? 'aborted' : 'other',
        usage: Object.fromEntries(['input', 'output', 'cacheRead', 'cacheWrite'].map(field => [field, safeCount(message.usage?.[field]) ? message.usage[field] : null])) });
      if (actualModel) responseModel = { id: actualModel, at: now() };
      if (!actualModel || actualModel !== selectedModel) context = null;
      const usage = message.usage;
      const reported = ['input', 'output', 'cacheRead', 'cacheWrite'].some(field => safeCount(usage?.[field]) && usage[field] > 0);
      if (message.stopReason !== 'error' && message.stopReason !== 'aborted' && reported && safeCount(usage.input) && safeCount(usage.cacheRead)
          && safeCount(usage.input + usage.cacheRead)) {
        lastInput = { tokens: usage.input + usage.cacheRead, at: now() };
        fresh = !!actualModel && actualModel === selectedModel; invalidated = null;
      }
      publish();
    });
    on('agent_end', () => {
      state = 'idle'; settle();
      if (fresh && !invalidated && responseModel?.id === selectedModel) {
        try { context = contextUsage(ctx.getContextUsage(), now()); } catch { context = null; }
      } else if (responseModel?.id !== selectedModel) context = null;
      publish();
    });
    on('agent_settled', () => { state = 'idle'; settle(); publish(); });
    on('tool_execution_start', event => {
      if (!key(event.toolCallId)) return;
      const id = idFor('child-tool', instance, event.toolCallId);
      if (seenTools.has(id) || tools.has(id)) return; // Includes recently evicted terminal rows.
      seenTools.add(id);
      if (seenTools.size > 256) seenTools.delete(seenTools.values().next().value);
      const tool = name(event.toolName) ?? 'tool';
      state = 'working';
      record('tool', `Running ${tool}`, { id, tool, state: 'running',
        ...(key(event.parentToolCallId) && event.parentToolCallId !== event.toolCallId ? { parentEventId: idFor('child-tool', instance, event.parentToolCallId) } : {}) });
      if (tools.size < CHILD_LIMIT.tools) tools.set(id, { name: tool, at: now() });
      else omitted = increment(omitted);
      publish();
    });
    on('tool_execution_end', event => {
      if (!key(event.toolCallId)) return;
      const id = idFor('child-tool', instance, event.toolCallId);
      tools.delete(id);
      const row = records.find(row => row.id === id);
      if (!row) {
        // Do not replay an execution whose row was already dropped. An unmatched
        // end is an omission, not an invented start or fabricated zero duration.
        if (!seenTools.has(id)) { omitted = increment(omitted); seenTools.add(id); if (seenTools.size > 256) seenTools.delete(seenTools.values().next().value); publish(); }
        return;
      }
      if (row.state !== 'running' && row.state !== 'unknown') return;
      const tool = name(event.toolName) ?? row.tool;
      row.state = event.isError ? 'failed' : 'finished';
      if (safeCount(event.durationMs)) row.durationMs = event.durationMs;
      row.label = `${event.isError ? 'Failed' : 'Finished'} ${tool}${safeCount(event.durationMs) ? ` · ${event.durationMs.toLocaleString('en-US')}ms` : ''}`;
      if (!row.parentEventId && key(event.parentToolCallId) && event.parentToolCallId !== event.toolCallId) row.parentEventId = idFor('child-tool', instance, event.parentToolCallId);
      if (!tools.size && ctx.isIdle?.()) state = 'idle';
      publish();
    });
    const invalidate = reason => { context = null; fresh = false; invalidated = reason; record('context', reason === 'compaction' ? 'Context compacted' : 'Selected model changed'); publish(); };
    on('session_compact', () => invalidate('compaction'));
    on('model_select', event => { selectedModel = observedModel(event.model); invalidate('model-change'); });
    on('session_shutdown', close);
  } catch {
    close();
    for (const off of subscriptions) { try { off(); } catch { /* idempotent partial-install cleanup */ } }
  }
}


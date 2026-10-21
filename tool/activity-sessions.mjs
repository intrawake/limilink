/** Parent projection of actual SDK sessions. Never join native run/step cards.
 * Trusted host-owned directory only; no journals, process hooks or provider calls.
 */
import { randomUUID } from 'node:crypto';
import { constants, openSync, closeSync, fstatSync, readSync, mkdirSync, writeFileSync, unlinkSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';
import { CHILD_LIMIT, instanceId, sessionKey, fileKey, slotName, privateDirectory } from './activity-child.mjs';
import { contextUsage, idFor, keyedIdFor, modelName, name, safeCount, usageLabel } from './activity-metadata.mjs';

const RETAIN_MS = 5 * 60 * 1000;
const eventKey = value => typeof value === 'string' && /^child-(event|tool):[0-9a-f]{32}$/.test(value);
const statuses = new Set(['running', 'finished', 'failed', 'stopped', 'unknown']);
function readPrivateText(path, limit) {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const info = fstatSync(fd);
    if (!info.isFile() || info.uid !== process.getuid() || (info.mode & 0o077) !== 0 || info.size > limit) return null;
    const buffer = Buffer.alloc(limit + 1);
    const bytes = readSync(fd, buffer); // Fixed-size read even if a writer changes size.
    if (bytes > limit) return null;
    return buffer.subarray(0, bytes).toString('utf8');
  } finally { closeSync(fd); }
}
export function readPrivateJSON(path, limit) {
  const value = readPrivateText(path, limit);
  return value === null ? null : JSON.parse(value);
}

function safeSource(raw, config, now) {
  if (raw?.version !== 1 || raw.token !== config.token || raw.rootKey !== config.rootKey || !instanceId(raw.instance)
      || !sessionKey(raw.sessionKey) || raw.sessionKey === config.rootKey || !fileKey(raw.fileKey) || !fileKey(raw.parentKey)
      || !/^uuid:[0-9a-f]{32}$/.test(raw.uuidKey ?? '') || raw.parentKey === raw.fileKey
      || !safeCount(raw.revision) || !safeCount(raw.updatedAt) || raw.updatedAt > now + CHILD_LIMIT.staleMs
      || !['idle', 'working', 'closed'].includes(raw.state) || !safeCount(raw.omitted)
      || !Array.isArray(raw.records) || raw.records.length > CHILD_LIMIT.records) return null;
  const source = { instance: raw.instance, sessionKey: raw.sessionKey, fileKey: raw.fileKey, uuidKey: raw.uuidKey, parentKey: raw.parentKey,
    revision: raw.revision, updatedAt: raw.updatedAt, state: raw.state, omitted: raw.omitted, records: [] };
  const selected = modelName(raw.selectedModel);
  if (selected) source.selectedModel = selected;
  if (modelName(raw.responseModel?.id) && safeCount(raw.responseModel.at)) source.responseModel = { id: raw.responseModel.id, at: raw.responseModel.at };
  if (safeCount(raw.lastInput?.tokens) && safeCount(raw.lastInput.at)) source.lastInput = { tokens: raw.lastInput.tokens, at: raw.lastInput.at };
  if (['compaction', 'model-change'].includes(raw.invalidated)) source.invalidated = raw.invalidated;
  if (raw.context && safeCount(raw.context.observedAt) && source.responseModel?.id === source.selectedModel && source.lastInput) source.context = contextUsage(raw.context, raw.context.observedAt);
  const tool = name(raw.currentTool);
  if (tool) source.currentTool = tool;
  const seen = new Set();
  for (const row of raw.records) {
    if (!row || !eventKey(row.id) || seen.has(row.id) || !safeCount(row.at)) continue;
    seen.add(row.id);
    let label, extra = {};
    if (row.kind === 'tool' && name(row.tool) && statuses.has(row.state)) {
      label = `${row.state === 'running' ? 'Running' : row.state === 'finished' ? 'Finished' : row.state === 'failed' ? 'Failed' : row.state === 'stopped' ? 'Stopped' : 'Outcome not observed'} ${row.tool}`;
      if (safeCount(row.durationMs)) label += ` · ${row.durationMs.toLocaleString('en-US')}ms`;
      extra = { state: row.state, ...(eventKey(row.parentEventId) && row.parentEventId !== row.id ? { parentEventId: row.parentEventId } : {}) };
    } else if (row.kind === 'model') {
      const model = modelName(row.model);
      const usage = Object.fromEntries(['input', 'output', 'cacheRead', 'cacheWrite'].map(field => [field, safeCount(row.usage?.[field]) ? row.usage[field] : null]));
      label = usageLabel(usage, `Response${model ? ` ${model.slice(0, 96)}` : ''}${row.stopReason === 'error' ? ' (error)' : row.stopReason === 'aborted' ? ' (aborted)' : ''}`);
    } else if (row.kind === 'session' && ['Session observer started', 'Session observer closed'].includes(row.label)) label = row.label;
    else if (row.kind === 'agent' && row.label === 'Session agent started') label = row.label;
    else if (row.kind === 'context' && ['Context compacted', 'Selected model changed'].includes(row.label)) label = row.label;
    if (label) source.records.push({ id: row.id, at: row.at, kind: row.kind, label: label.slice(0, 200), ...extra });
  }
  return source;
}

export function createSessionStore(config, options = {}) {
  const now = options.now ?? Date.now;
  const sources = new Map();
  let lastRead = -Infinity, limited = false;
  const scan = () => {
    if (now() - lastRead >= 0 && now() - lastRead < 1000) return;
    lastRead = now(); limited = false;
    try {
      if (!privateDirectory(config.directory)) { limited = true; return; }
      try { const marker = readPrivateJSON(join(config.directory, '.limited.json'), 2048); limited = marker?.version === 1 && marker.token === config.token && marker.limited === true; } catch (error) { if (error.code !== 'ENOENT') limited = true; }
      // Fixed slots bound both directory work and disk admission. No arbitrary names.
      for (let slot = 0; slot < CHILD_LIMIT.instances; slot++) {
        const path = join(config.directory, slotName(slot));
        let source;
        try { source = safeSource(readPrivateJSON(path, CHILD_LIMIT.bytes), config, now()); }
        catch (error) { if (error.code !== 'ENOENT') limited = true; continue; }
        if (!source) { limited = true; continue; }
        const old = sources.get(source.instance);
        if (old && (source.sessionKey !== old.sessionKey || source.fileKey !== old.fileKey || source.uuidKey !== old.uuidKey
            || source.parentKey !== old.parentKey || source.revision < old.revision || (old.state === 'closed' && source.state !== 'closed'))) { limited = true; continue; }
        if (old && source.revision === old.revision) {
          if (JSON.stringify(source) !== JSON.stringify(old)) limited = true;
          else if (source.state === 'closed' && now() - source.updatedAt > RETAIN_MS) { try { unlinkSync(path); } catch { /* own closed transport */ } }
          continue;
        }
        if (sources.size >= CHILD_LIMIT.instances && !old) {
          const victim = [...sources.values()].filter(row => row.state === 'closed').sort((a, b) => a.updatedAt - b.updatedAt)[0];
          if (!victim) { limited = true; continue; }
          sources.delete(victim.instance); limited = true;
        }
        sources.set(source.instance, source);
        // Only explicit owning shutdown permits transport reclamation. Retain a
        // bounded in-memory tail, never infer termination from TTL or omission.
        if (source.state === 'closed' && now() - source.updatedAt > RETAIN_MS) {
          try { unlinkSync(path); } catch { /* own best-effort transport only */ }
        }
      }
    } catch { limited = true; }
  };
  return {
    project(maxNodes = 63) {
      scan();
      const groups = new Map(), files = new Map([[config.rootFileKey, new Set([config.rootKey])]]);
      for (const source of sources.values()) {
        if (!groups.has(source.sessionKey)) groups.set(source.sessionKey, []);
        groups.get(source.sessionKey).push(source);
        if (!files.has(source.fileKey)) files.set(source.fileKey, new Set());
        files.get(source.fileKey).add(source.sessionKey);
      }
      const nodes = [], events = [], edges = [];
      for (const [id, rows] of groups) {
        const open = rows.filter(row => row.state !== 'closed'), active = open.length === 1 ? open[0] : null;
        // Parent claims are immutable historical header facts, not current delegation.
        const parents = new Set(rows.map(row => row.parentKey)), parentFile = parents.size === 1 ? [...parents][0] : null;
        const identityConflict = new Set(rows.map(row => `${row.fileKey}:${row.uuidKey}`)).size !== 1;
        const ancestryConflict = parents.size !== 1 || identityConflict;
        const conflict = open.length > 1 || ancestryConflict;
        const parentIds = files.get(parentFile), parent = parentIds?.size === 1 ? [...parentIds][0] : null;
        const parentAmbiguous = parentIds?.size > 1;
        const status = conflict ? 'conflict' : active && now() - active.updatedAt > CHILD_LIMIT.staleMs ? 'stale' : active ? 'open' : 'closed';
        const observedAt = Math.max(...rows.map(row => row.updatedAt));
        const response = active?.responseModel ?? rows.map(row => row.responseModel).filter(Boolean).sort((a, b) => b.at - a.at)[0];
        const input = rows.map(row => row.lastInput).filter(Boolean).sort((a, b) => b.at - a.at)[0];
        const model = response?.id ?? (!conflict ? active?.selectedModel : null);
        const node = { id, parentId: !ancestryConflict && !parentAmbiguous ? parent === config.rootKey ? 'parent' : parent : null,
          label: `Child session ${id.slice(-8)}`, kind: 'agent', state: status === 'open' ? active.state : status === 'closed' ? 'closed' : 'unknown', updatedAt: observedAt,
          observation: { basis: 'pi-session-events', status, observedAt, ancestry: ancestryConflict || parentAmbiguous ? 'ambiguous' : parent ? 'file-reference' : 'unresolved',
            omitted: Math.min(Number.MAX_SAFE_INTEGER, rows.reduce((n, row) => n + row.omitted, 0)),
            ...(model ? { modelBasis: response ? 'response' : 'selected' } : {}),
            ...(!conflict && active?.selectedModel ? { selectedModel: active.selectedModel } : {}),
            ...(response ? { modelObservedAt: response.at } : {}), ...(input ? { lastInputObservedAt: input.at } : {}),
            ...(active?.invalidated ? { invalidated: active.invalidated } : {}) } };
        if (model) node.model = model;
        if (input) node.lastInputTokens = input.tokens;
        if (status === 'open' && active.context && !active.invalidated) node.context = active.context;
        if (!conflict && active?.currentTool) node.currentTool = active.currentTool;
        nodes.push(node);
        const tail = rows.flatMap(row => row.records.map(event => ({ ...event,
          id: idFor('session-event', id, row.instance, event.id), nodeId: id,
          ...(event.parentEventId ? { parentEventId: idFor('session-event', id, row.instance, event.parentEventId) } : {}) })));
        const retained = tail.sort((a, b) => a.at - b.at).slice(-24);
        node.observation.omitted = Math.min(Number.MAX_SAFE_INTEGER, node.observation.omitted + tail.length - retained.length);
        events.push(...retained);
      }
      const lookup = new Map(nodes.map(node => [node.id, node]));
      const depth = node => {
        const seen = new Set([node.id]); let ancestor = node, value = 0;
        while (ancestor.parentId && lookup.has(ancestor.parentId)) {
          if (seen.has(ancestor.parentId)) return -1;
          seen.add(ancestor.parentId); ancestor = lookup.get(ancestor.parentId); value++;
        }
        return value;
      };
      const ordered = nodes.map(node => ({ node, depth: depth(node) }));
      // Evaluate every cycle before mutating any parent claim.
      for (const entry of ordered) if (entry.depth < 0) { entry.node.parentId = null; entry.node.observation.ancestry = 'ambiguous'; entry.depth = 0; }
      ordered.sort((a, b) => a.depth - b.depth);
      const kept = ordered.slice(0, maxNodes).map(entry => entry.node), ids = new Set(['parent', ...kept.map(node => node.id)]);
      for (const node of kept) {
        if (node.parentId && !ids.has(node.parentId)) { node.parentId = null; node.observation.ancestry = 'unresolved'; }
        if (node.parentId) edges.push({ id: idFor('session-parent', node.parentId, node.id), source: node.parentId, target: node.id, kind: 'ancestry', label: 'Header parent file (historical)' });
      }
      return { nodes: kept, edges, events: events.filter(row => ids.has(row.nodeId)), limited: limited || nodes.length > maxNodes };
    },
  };
}

/** Public export resolution is anchored to the actual Pi CLI, never cwd. */
export async function resolveChildRegistration(host = process.argv[1]) {
  if (!isAbsolute(host ?? '')) throw new Error('Unsupported Pi host');
  const entry = createRequire(pathToFileURL(host)).resolve('pi-subagents/required-child-extensions');
  const api = await import(pathToFileURL(entry).href);
  if (typeof api.registerRequiredChildExtensions !== 'function') throw new Error('Unsupported child extension API');
  return api.registerRequiredChildExtensions;
}

export async function createSessionTracking(ctx, activityPath, options = {}) {
  let registration;
  try {
    const file = ctx.sessionManager.getSessionFile(), uuid = ctx.sessionManager.getSessionId();
    if (!isAbsolute(file ?? '') || typeof uuid !== 'string' || !uuid) return null;
    const scopeKey = idFor('private-root', file, uuid), directory = join(dirname(activityPath), '.activity-sessions');
    try { mkdirSync(directory, { mode: 0o700 }); } catch (error) { if (error.code !== 'EEXIST') return null; }
    if (!privateDirectory(directory)) return null;
    const ownerPath = join(directory, '.owner.json');
    try { writeFileSync(ownerPath, JSON.stringify({ version: 1, scopeKey, token: randomUUID() }), { mode: 0o600, flag: 'wx' }); }
    catch (error) { if (error.code !== 'EEXIST') return null; }
    const owner = readPrivateJSON(ownerPath, 2048);
    // One bounded family per Limilink conversation. A different SDK root safely
    // declines rather than replacing retained bootstrap paths or adopting history.
    if (owner?.version !== 1 || owner.scopeKey !== scopeKey || !instanceId(owner.token)) return null;
    const config = { directory, token: owner.token, rootKey: keyedIdFor(owner.token, 'session', file, uuid), rootFileKey: keyedIdFor(owner.token, 'file', file) };
    const bootstrap = join(directory, 'observer.mjs');
    const code = `export default async function(pi){try{const {installChildObserver}=await import(${JSON.stringify(new URL('./activity-child.mjs', import.meta.url).href)});installChildObserver(pi,${JSON.stringify(config)});}catch{/* optional telemetry */}}\n`;
    if (Buffer.byteLength(code) > 4096) return null;
    // First creation completes before registration. Never replace an existing
    // retained bootstrap; an incomplete/foreign/moved-code file declines safely.
    try { writeFileSync(bootstrap, code, { mode: 0o600, flag: 'wx' }); }
    catch (error) { if (error.code !== 'EEXIST') return null; }
    if (readPrivateText(bootstrap, 4096) !== code) return null;
    const register = options.register ?? await resolveChildRegistration();
    registration = register({ sessionId: uuid, extensions: [{ id: 'limilink-session-observer', path: bootstrap }] });
    const store = createSessionStore(config, options);
    return { project: store.project, dispose() { registration?.dispose(); registration = null; } };
  } catch { registration?.dispose(); return null; }
}

/** Per-session fairness before the global 40-row budget; never one share per observer. */
export function sessionEventTail(mainEvents, childEvents, limit = 40) {
  const groups = new Map();
  for (const event of [...mainEvents, ...childEvents]) {
    const owner = event.nodeId ?? 'parent';
    if (!groups.has(owner)) groups.set(owner, []);
    groups.get(owner).push(event);
  }
  for (const rows of groups.values()) rows.sort((a, b) => b.at - a.at);
  const admitted = [];
  for (let round = 0; admitted.length < limit; round++) {
    let added = false;
    for (const rows of groups.values()) if (rows[round] && admitted.length < limit) { admitted.push(rows[round]); added = true; }
    if (!added) break;
  }
  return admitted.sort((a, b) => a.at - b.at);
}

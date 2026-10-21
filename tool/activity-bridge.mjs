/** Read-only Pi extension. Host supplies LIMILINK_ACTIVITY_PATH,
 * LIMILINK_ACTIVITY_SESSION_DIR and LIMILINK_ACTIVITY_OWNER_CWD. An optional
 * LIMILINK_ACTIVITY_PID further restricts ownership. No Pi-internal imports,
 * provider calls or tool control.
 * Source contracts: Pi extensions/types; pi-subagents public v1 status RPC.
 */
import { randomUUID } from 'node:crypto';
import { dirname, isAbsolute, resolve } from 'node:path';
import { contextUsage, finite, idFor, key, modelName, name, responseUsageLabel, usageLabel, writeAtomicSnapshot } from './activity-metadata.mjs';
import { createSessionTracking, sessionEventTail } from './activity-sessions.mjs';
export { contextUsage, responseUsageLabel, writeAtomicSnapshot } from './activity-metadata.mjs';

const REQUEST = 'subagents:rpc:v1:request';
const REPLY = 'subagents:rpc:v1:reply:';
// Optional public completion channel advertised by pi-subagents' RPC ping.
const CHILD_COMPLETE = 'subagent:async-complete';
const PENDING_CHILD_MS = 5 * 60 * 1000;
const LIMIT = { nodes: 64, edges: 128, events: 40, tools: 64 };
const nativeStates = new Set(['queued', 'running', 'complete', 'failed', 'partial', 'paused', 'stopped', 'rejected']);
// Only the public display label, never task/goal bodies. Refuse paths, controls
// and oversized labels rather than making an arbitrary payload UI-visible.
const publicLabel = (s) => typeof s === 'string' && s.length > 0 && s.length <= 160 && !/[\x00-\x1f\x7f/\\]/.test(s) ? s : null;

/** Task bodies/paths, tool args/results, goals and usage totals are ignored.
 * Fleet input is only a last-observed input count, NOT live context occupancy.
 * Fleet and hierarchy may describe the same child: they are separate observations,
 * deliberately not joined without an explicit public correlation identifier.
 */
export function mapSubagents(data, at) {
  const nodes = [], edges = [], seen = new Set(), eligibleRoots = new Set();
  const snapshot = data?.asyncSnapshot;
  const completeChildren = snapshot?.omitted?.children === 0;
  const visit = (row, parentId, depth) => {
    if (!row || !key(row.id) || depth > 8 || nodes.length >= LIMIT.nodes - 1) return;
    const id = idFor('async', parentId, row.id);
    if (seen.has(id)) return;
    seen.add(id);
    if (parentId === 'parent' && row.kind === 'subagent') eligibleRoots.add(id);
    const kind = row.kind === 'workflow' ? 'workflow' : row.kind === 'step' || row.kind === 'host-step' ? 'step' : 'agent';
    const nativeState = nativeStates.has(row.state) ? row.state : 'unknown';
    const node = { id, parentId, label: publicLabel(row.label) ?? `${kind} (${nativeState})`, kind, state: nativeState };
    if (finite(row.updatedAt)) node.updatedAt = row.updatedAt;
    const children = Array.isArray(row.children) ? row.children : [];
    const step = children.length === 1 ? children[0] : null;
    // Public runs include execution rows, not just delegated agents. Fold only
    // an unambiguous sole step; never deduplicate by name, timing or fleet key.
    const fold = completeChildren && depth < 8 && row.kind === 'subagent' && step?.kind === 'step'
      && key(step.id) && nativeStates.has(row.state) && step.state === row.state;
    const tool = name(row.activity?.currentTool) ?? (fold && nativeState === 'running' ? name(step.activity?.currentTool) : null);
    if (tool) node.currentTool = tool;
    nodes.push(node);
    if (edges.length < LIMIT.edges) edges.push({ id: idFor('delegation', parentId, id), source: parentId, target: id, kind: 'delegation', label: kind === 'step' ? 'Execution step' : 'delegation' });
    const descendants = fold ? Array.isArray(step.children) ? step.children : [] : children;
    // Hidden source steps still consume depth, so folding cannot bypass bounds.
    for (const child of descendants.slice(0, LIMIT.nodes)) visit(child, id, depth + (fold ? 2 : 1));
  };
  if (snapshot?.version === 1 && snapshot.kind === 'pi-subagents.async-status-snapshot' && Array.isArray(snapshot.runs)) {
    for (const row of snapshot.runs.slice(0, LIMIT.nodes)) visit(row, 'parent', 0);
  }
  if (data?.fleet?.version === 1 && Array.isArray(data.fleet.entries)) {
    for (const row of data.fleet.entries.slice(0, LIMIT.nodes)) {
      if (nodes.length >= LIMIT.nodes - 1) break;
      if (!row || !key(row.key)) continue;
      const id = idFor('fleet', row.key);
      if (seen.has(id)) continue;
      seen.add(id);
      const input = finite(row.tokens?.window) ? Math.floor(row.tokens.window) : null;
      const node = { id, parentId: null, label: `Live model: ${name(row.agent) ?? 'agent'}`,
        kind: 'agent', state: 'working', updatedAt: at };
      if (input !== null) node.lastInputTokens = input;
      const model = modelName(row.model);
      if (model) node.model = model;
      nodes.push(node);
    }
  }
  // Internal correlation set, never serialized into the activity snapshot.
  return { nodes, edges, eligibleRoots };
}

export function installActivityBridge(pi, options = {}) {
  const env = options.env ?? process.env;
  const pid = options.pid ?? process.pid;
  const path = env.LIMILINK_ACTIVITY_PATH;
  const sessionDir = env.LIMILINK_ACTIVITY_SESSION_DIR;
  const ownerCwd = env.LIMILINK_ACTIVITY_OWNER_CWD;
  // PID alone cannot exclude local children, which share the parent's process.
  if (!path || !isAbsolute(path) || !sessionDir || !isAbsolute(sessionDir) ||
      !ownerCwd || !isAbsolute(ownerCwd) || env.PI_SUBAGENT_CHILD === '1' ||
      (env.LIMILINK_ACTIVITY_PID !== undefined && env.LIMILINK_ACTIVITY_PID !== String(pid))) return;
  const now = options.now ?? Date.now;
  const schedule = options.setInterval ?? setInterval;
  const unschedule = options.clearInterval ?? clearInterval;
  const write = options.write ?? writeAtomicSnapshot;
  let ctx, sessionId, packageSession, timer, pending, childOff, generation = 0, active = false, invalidContext = false, tracking;
  // Source-only opt-in until separately approved deployment/backend activation.
  const trackingRequested = env.LIMILINK_ACTIVITY_CHILD_SESSIONS === '1';
  let state = 'idle', model = null, context = null, graph = { nodes: [], edges: [], eligibleRoots: new Set() };
  let subagentsAvailable = false, eventSequence = 0;
  const tools = new Map(), childFacts = new Map(), events = [], communications = [];

  const owns = (candidate) => {
    try {
      const header = candidate?.sessionManager.getHeader();
      const file = candidate?.sessionManager.getSessionFile();
      return !!header && header.parentSession === undefined && typeof file === 'string' && isAbsolute(file) &&
        typeof candidate.cwd === 'string' && resolve(candidate.cwd) === resolve(ownerCwd) &&
        resolve(dirname(file)) === resolve(sessionDir) && key(candidate.sessionManager.getSessionId());
    } catch { return false; }
  };
  const record = (kind, label, extra = {}) => {
    const row = { id: `event:${++eventSequence}`, at: now(), kind, label, nodeId: 'parent', ...extra };
    events.push(row);
    if (events.length > LIMIT.events) events.shift();
    return row;
  };
  const toolEvent = (event, state, label) => {
    const id = key(event.toolCallId) ? idFor('tool', event.toolCallId) : null;
    let row = id && events.find(row => row.id === id && row.kind === 'tool');
    if (!row) row = record('tool', label, id ? { id } : {});
    // A duplicate/late start must not resurrect an observed terminal result.
    if (state !== 'running' || !row.state || row.state === 'running') {
      row.label = label; row.state = state;
    }
    if (!row.parentEventId && key(event.parentToolCallId)) {
      const parent = idFor('tool', event.parentToolCallId);
      if (parent !== row.id) row.parentEventId = parent;
    }
    return row;
  };
  const settleTools = (aborted) => {
    for (const row of events) {
      if (row.nodeId !== 'parent' || row.kind !== 'tool' || row.state !== 'running') continue;
      row.state = aborted ? 'stopped' : 'unknown';
      row.label = `${aborted ? 'Stopped' : 'Outcome not observed'} ${row.label.replace(/^Running /, '')}`;
    }
    tools.clear();
  };
  // Native supervisor metadata is correlated only with observed top-level run IDs.
  // Workflow step IDs and fleet keys are NOT run IDs; absent matches are omitted.
  const communication = (kind, requestId, runId, reason) => {
    if (!key(requestId) || !key(runId)) return;
    const nodeId = idFor('async', 'parent', runId);
    if (!graph.nodes.some(node => node.id === nodeId && node.parentId === 'parent')) return;
    const id = idFor('communication', kind, requestId, runId);
    if (communications.some(edge => edge.id === id)) return;
    const label = kind === 'reply' ? 'Supervisor reply' : reason === 'progress_update' ? 'Supervisor update' : 'Supervisor request';
    communications.push({ id, source: kind === 'reply' ? 'parent' : nodeId,
      target: kind === 'reply' ? nodeId : 'parent', kind, label, at: now() });
    if (communications.length > LIMIT.events) communications.shift();
    record(kind, label);
  };
  const observe = () => {
    model = modelName(ctx?.model?.id);
    if (invalidContext) { context = null; return; }
    try { context = contextUsage(ctx.getContextUsage(), now()); } catch { context = null; }
  };
  const applyChildFacts = () => {
    for (const [id, fact] of childFacts) {
      if ((!fact.promoted && now() - fact.seenAt > PENDING_CHILD_MS) || (fact.promoted && !graph.eligibleRoots.has(id))) {
        childFacts.delete(id); continue;
      }
      if (!graph.eligibleRoots.has(id)) continue;
      const node = graph.nodes.find(node => node.id === id);
      if (!node) continue; // Never create a node or join a fleet/step observation.
      fact.promoted = true;
      if (fact.model) node.model = fact.model;
      const row = events.find(row => row.id === fact.eventId && row.nodeId === id && row.kind === 'usage');
      if (row) row.label = fact.label;
      else if (!fact.recorded) {
        record('usage', fact.label, { id: fact.eventId, nodeId: id, at: fact.firstAt });
        fact.recorded = true;
      }
    }
  };
  const publish = () => {
    if (!active) return;
    applyChildFacts();
    const at = now();
    const runningTools = [...tools.values()];
    const root = { id: 'parent', parentId: null, label: 'Assistant', kind: 'agent', state, updatedAt: at };
    if (model) root.model = model;
    if (context) root.context = context;
    if (runningTools.length) root.currentTool = runningTools.at(-1).name;
    try {
      // Reserve space for both representations, never equate them or count their
      // sum as agents. Native completion facts/communications remain run-owned.
      let children;
      try { children = tracking?.project(LIMIT.nodes - 1 - Math.min(graph.nodes.length, 32)); } catch { /* graph still wins over optional telemetry */ }
      const native = graph.nodes.slice(0, LIMIT.nodes - 1 - (children?.nodes.length ?? 0));
      const nodes = [root, ...(children?.nodes ?? []), ...native];
      const ids = new Set(nodes.map(node => node.id));
      const edges = [...(children?.edges ?? []), ...graph.edges, ...communications].filter(edge => ids.has(edge.source) && ids.has(edge.target)).slice(0, LIMIT.edges);
      const mainEvents = events.filter(row => ids.has(row.nodeId ?? 'parent'));
      const history = children ? sessionEventTail(mainEvents, children.events, LIMIT.events) : [...mainEvents];
      if (children) for (const node of children.nodes) {
        const count = children.events.filter(row => row.nodeId === node.id).length - history.filter(row => row.nodeId === node.id).length;
        node.observation.omitted = Math.min(Number.MAX_SAFE_INTEGER, node.observation.omitted + count);
      }
      write(path, { version: 1, sessionId, updatedAt: at, state, model, context, tools: runningTools,
        nodes, edges, events: history, subagentsAvailable,
        ...(trackingRequested ? { sessionTracking: { available: !!children, limited: !!children?.limited || native.length < graph.nodes.length } } : {}) });
    } catch { /* Observer failures never block agent execution or expose error paths. */ }
  };
  const childComplete = (data) => {
    // Public lifecycle artifact v3 (pi-subagents 0.78). Its package session
    // identity is the session FILE when persisted, not the exported Pi UUID.
    if (data?.lifecycleArtifactVersion !== 3 || data.sessionId !== packageSession || data.mode !== 'single'
      || !key(data.runId) || (data.id !== undefined && data.id !== data.runId)
      || !['complete', 'failed', 'partial', 'stopped', 'rejected'].includes(data.state)
      || !Number.isSafeInteger(data.timestamp) || data.timestamp < 0
      || (data.awaitedByWorkflow !== undefined && data.awaitedByWorkflow !== false)
      || data.parentWorkflowRunId !== undefined || data.workflowKey !== undefined
      || !Array.isArray(data.results) || data.results.length !== 1) return;
    const result = data.results[0];
    if (!result || typeof result !== 'object' || Array.isArray(result) || result.skipped || result.workflowKey !== undefined
      || (result.runId !== undefined && result.runId !== data.runId)) return;
    const id = idFor('async', 'parent', data.runId), previous = childFacts.get(id);
    // Exact duplicates and ambiguous same/older publications never add totals
    // or silently replace newer evidence. Only sanitized bounded facts survive.
    if (previous && data.timestamp <= previous.latestAt) return;
    const suffix = data.state === 'complete' ? '' : ` (${data.state})`;
    childFacts.set(id, { model: modelName(result.model) ?? previous?.model,
      label: usageLabel(result.usage, `Reported run total${suffix}`),
      eventId: idFor('run-usage', sessionId, generation, data.runId),
      firstAt: previous?.firstAt ?? data.timestamp, latestAt: data.timestamp, seenAt: now(),
      recorded: previous?.recorded ?? false, promoted: previous?.promoted ?? false });
    if (childFacts.size > LIMIT.nodes - 1) childFacts.delete(childFacts.keys().next().value);
    publish();
  };
  const cancelPending = () => {
    pending?.off();
    pending = undefined;
  };
  const poll = () => {
    if (!active) return;
    if (pending && now() - pending.at < 5000) return;
    if (pending) { cancelPending(); subagentsAvailable = false; publish(); }
    const requestId = randomUUID();
    const off = pi.events.on(`${REPLY}${requestId}`, (reply) => {
      if (!active || pending?.id !== requestId) return;
      cancelPending();
      if (reply?.version !== 1 || reply.requestId !== requestId || reply.success !== true) {
        subagentsAvailable = false;
      } else {
        subagentsAvailable = true;
        graph = mapSubagents(reply.data, now());
        const ids = new Set(['parent', ...graph.nodes.map(node => node.id)]);
        for (let i = communications.length - 1; i >= 0; i--) {
          if (!ids.has(communications[i].source) || !ids.has(communications[i].target)) communications.splice(i, 1);
        }
      }
      publish();
    });
    pending = { id: requestId, at: now(), off };
    try { pi.events.emit(REQUEST, { version: 1, requestId, method: 'status', params: {} }); }
    catch { cancelPending(); subagentsAvailable = false; }
  };
  const stop = () => {
    generation++;
    childOff?.(); childOff = undefined;
    try { tracking?.dispose(); } catch { /* fail soft */ } tracking = undefined;
    childFacts.clear();
    if (timer !== undefined) unschedule(timer);
    timer = undefined;
    cancelPending();
    active = false;
  };
  const on = (event, handler) => pi.on(event, (data, candidate) => {
    if (!active || !owns(candidate) || candidate.sessionManager.getSessionId() !== sessionId) return;
    ctx = candidate;
    handler(data);
  });
  pi.on('session_start', (_event, candidate) => {
    stop();
    if (!owns(candidate)) return;
    ctx = candidate;
    sessionId = candidate.sessionManager.getSessionId();
    // Real Pi IDs are UUIDs; do not export arbitrary identity strings or paths.
    if (!/^[a-zA-Z0-9_-]{1,128}$/.test(sessionId)) return;
    active = true;
    state = ctx.isIdle() ? 'idle' : 'working';
    tools.clear(); events.length = 0; communications.length = 0; graph = { nodes: [], edges: [], eligibleRoots: new Set() };
    subagentsAvailable = false; invalidContext = false;
    packageSession = ctx.sessionManager.getSessionFile() ?? sessionId;
    const ownerGeneration = generation;
    childOff = pi.events.on(CHILD_COMPLETE, data => {
      if (active && generation === ownerGeneration) childComplete(data);
    });
    observe(); record('session', 'Session started'); publish(); poll();
    timer = schedule(() => { observe(); publish(); poll(); }, 1000);
    timer?.unref?.();
    if (trackingRequested) {
      const setup = options.createSessionTracking ?? createSessionTracking;
      return Promise.resolve().then(() => setup(candidate, path, { now, ...(options.registerChildExtensions ? { register: options.registerChildExtensions } : {}) }))
        .then(result => {
          if (!active || generation !== ownerGeneration) { result?.dispose(); return; }
          tracking = result; publish();
        }).catch(() => { /* Optional registration never replaces another owner. */ });
    }
  });
  on('agent_start', () => { state = 'working'; record('agent', 'Agent started'); observe(); publish(); });
  on('agent_end', () => { observe(); publish(); }); // Not the final settle boundary.
  on('agent_settled', (event) => {
    state = event.aborted ? 'stopped' : state === 'error' ? 'error' : 'idle';
    settleTools(event.aborted); observe(); record('agent', event.aborted ? 'Agent stopped' : 'Agent settled'); publish(); poll();
  });
  on('tool_execution_start', (event) => {
    if (!key(event.toolCallId)) return;
    const id = idFor('tool', event.toolCallId), toolName = name(event.toolName) ?? 'tool';
    const row = toolEvent(event, 'running', `Running ${toolName}`);
    if (row.state === 'running' && !tools.has(id) && tools.size < LIMIT.tools) {
      tools.set(id, { id, name: toolName, startedAt: row.at });
    }
    publish();
  });
  on('tool_execution_end', (event) => {
    if (key(event.toolCallId)) tools.delete(idFor('tool', event.toolCallId));
    const duration = Number.isSafeInteger(event.durationMs) && event.durationMs >= 0 ? ` · ${event.durationMs.toLocaleString('en-US')}ms` : '';
    toolEvent(event, event.isError ? 'failed' : 'finished', `${event.isError ? 'Failed' : 'Finished'} ${name(event.toolName) ?? 'tool'}${duration}`);
    if (event.toolName === 'subagent_supervisor' && !event.isError && !event.result?.isError) {
      const details = event.result?.details;
      communication('reply', details?.replyTo, details?.runId);
    }
    publish();
  });
  on('session_compact', () => { invalidContext = true; context = null; record('context', 'Context compacted'); publish(); });
  on('message_end', (event) => {
    if (event.message?.role === 'custom' && event.message.customType === 'subagent_supervisor_request') {
      const details = event.message.details;
      communication('message', details?.requestId, details?.runId, details?.reason);
      publish();
      return;
    }
    if (event.message?.role !== 'assistant') return;
    record('model', responseUsageLabel(event.message));
    if (event.message.stopReason === 'error') state = 'error';
    // Compaction invalidates occupancy until a fresh successful provider response.
    if (event.message.stopReason !== 'error' && event.message.stopReason !== 'aborted') {
      invalidContext = false;
      if (state === 'error') state = 'working';
    }
    observe(); publish();
  });
  on('model_select', (event) => { observe(); model = modelName(event.model?.id); publish(); });
  on('session_shutdown', () => {
    if (state === 'working') state = 'stopped';
    settleTools(true); record('session', 'Session closed'); publish(); stop();
  });
}

export default function activityBridge(pi) { installActivityBridge(pi); }

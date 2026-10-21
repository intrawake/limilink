/** Read-only Pi extension. Host supplies LIMILINK_ACTIVITY_PATH,
 * LIMILINK_ACTIVITY_SESSION_DIR and LIMILINK_ACTIVITY_OWNER_CWD. An optional
 * LIMILINK_ACTIVITY_PID further restricts ownership. No Pi-internal imports,
 * provider calls or tool control.
 * Source contracts: Pi extensions/types; pi-subagents public v1 status RPC.
 */
import { createHash, randomUUID } from 'node:crypto';
import { writeFileSync, renameSync, unlinkSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';

const REQUEST = 'subagents:rpc:v1:request';
const REPLY = 'subagents:rpc:v1:reply:';
const LIMIT = { nodes: 64, edges: 128, events: 40, tools: 64 };
const finite = (n) => typeof n === 'number' && Number.isFinite(n) && n >= 0;
// Names, never prose. Reject paths, whitespace, control characters and oversized values.
const name = (s) => typeof s === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,95}$/.test(s) ? s : null;
const modelName = (s) => typeof s === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_.:/-]{0,127}$/.test(s) && !s.includes('://') ? s : null;
const key = (s) => typeof s === 'string' && s.length > 0 && s.length <= 1024;
const idFor = (namespace, ...parts) => `${namespace}:${createHash('sha256').update(JSON.stringify(parts)).digest('hex').slice(0, 32)}`;
const nativeStates = new Set(['queued', 'running', 'complete', 'failed', 'partial', 'paused', 'stopped', 'rejected']);
// Only the public display label, never task/goal bodies. Refuse paths, controls
// and oversized labels rather than making an arbitrary payload UI-visible.
const publicLabel = (s) => typeof s === 'string' && s.length > 0 && s.length <= 160 && !/[\x00-\x1f\x7f/\\]/.test(s) ? s : null;

export function contextUsage(usage, at) {
  if (!usage || !finite(usage.contextWindow) || usage.contextWindow <= 0) return null;
  const tokens = finite(usage.tokens) ? usage.tokens : null;
  return { tokens, contextWindow: usage.contextWindow,
    percent: tokens !== null && finite(usage.percent) ? usage.percent : null, observedAt: at, basis: 'estimate' };
}

/** Task bodies/paths, tool args/results, goals and usage totals are ignored.
 * Fleet input is only a last-observed input count, NOT live context occupancy.
 * Fleet and hierarchy may describe the same child: they are separate observations,
 * deliberately not joined without an explicit public correlation identifier.
 */
export function mapSubagents(data, at) {
  const nodes = [], edges = [], seen = new Set();
  const visit = (row, parentId, depth) => {
    if (!row || !key(row.id) || depth > 8 || nodes.length >= LIMIT.nodes - 1) return;
    const id = idFor('async', parentId, row.id);
    if (seen.has(id)) return;
    seen.add(id);
    const kind = row.kind === 'workflow' ? 'workflow' : row.kind === 'step' || row.kind === 'host-step' ? 'step' : 'agent';
    const nativeState = nativeStates.has(row.state) ? row.state : 'unknown';
    const node = { id, parentId, label: publicLabel(row.label) ?? `${kind} (${nativeState})`, kind, state: nativeState };
    if (finite(row.updatedAt)) node.updatedAt = row.updatedAt;
    const tool = name(row.activity?.currentTool);
    if (tool) node.currentTool = tool;
    nodes.push(node);
    if (edges.length < LIMIT.edges) edges.push({ id: idFor('delegation', parentId, id), source: parentId, target: id, kind: 'delegation', label: 'delegation' });
    if (Array.isArray(row.children)) for (const child of row.children.slice(0, LIMIT.nodes)) visit(child, id, depth + 1);
  };
  const snapshot = data?.asyncSnapshot;
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
  return { nodes, edges };
}

/** Same-directory rename publishes either the old or complete new JSON; mode 0600.
 * The containing session directory must already exist and be trusted by the host.
 */
export function writeAtomicSnapshot(path, snapshot) {
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, `${JSON.stringify(snapshot)}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    renameSync(temporary, path);
  } finally {
    try { unlinkSync(temporary); } catch { /* renamed, or creation failed */ }
  }
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
  let ctx, sessionId, timer, pending, active = false, invalidContext = false;
  let state = 'idle', model = null, context = null, graph = { nodes: [], edges: [] };
  let subagentsAvailable = false, eventSequence = 0;
  const tools = new Map(), events = [], communications = [];

  const owns = (candidate) => {
    try {
      const header = candidate?.sessionManager.getHeader();
      const file = candidate?.sessionManager.getSessionFile();
      return !!header && header.parentSession === undefined && typeof file === 'string' && isAbsolute(file) &&
        typeof candidate.cwd === 'string' && resolve(candidate.cwd) === resolve(ownerCwd) &&
        resolve(dirname(file)) === resolve(sessionDir) && key(candidate.sessionManager.getSessionId());
    } catch { return false; }
  };
  const record = (kind, label) => {
    events.push({ id: `event:${++eventSequence}`, at: now(), kind, label, nodeId: 'parent' });
    if (events.length > LIMIT.events) events.shift();
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
  const publish = () => {
    if (!active) return;
    const at = now();
    const runningTools = [...tools.values()];
    const root = { id: 'parent', parentId: null, label: 'Assistant', kind: 'agent', state, updatedAt: at };
    if (model) root.model = model;
    if (context) root.context = context;
    if (runningTools.length) root.currentTool = runningTools.at(-1).name;
    try {
      write(path, { version: 1, sessionId, updatedAt: at, state, model, context, tools: runningTools,
        nodes: [root, ...graph.nodes], edges: [...graph.edges, ...communications].slice(0, LIMIT.edges),
        events: [...events], subagentsAvailable });
    } catch { /* Observer failures never block agent execution or expose error paths. */ }
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
    tools.clear(); events.length = 0; communications.length = 0; graph = { nodes: [], edges: [] };
    subagentsAvailable = false; invalidContext = false;
    observe(); record('session', 'Session started'); publish(); poll();
    timer = schedule(() => { observe(); publish(); poll(); }, 1000);
    timer?.unref?.();
  });
  on('agent_start', () => { state = 'working'; record('agent', 'Agent started'); observe(); publish(); });
  on('agent_end', () => { observe(); publish(); }); // Not the final settle boundary.
  on('agent_settled', (event) => {
    state = event.aborted ? 'stopped' : state === 'error' ? 'error' : 'idle';
    tools.clear(); observe(); record('agent', event.aborted ? 'Agent stopped' : 'Agent settled'); publish(); poll();
  });
  on('tool_execution_start', (event) => {
    if (!key(event.toolCallId)) return;
    const id = idFor('tool', event.toolCallId), toolName = name(event.toolName) ?? 'tool';
    if (tools.size < LIMIT.tools || tools.has(id)) tools.set(id, { id, name: toolName, startedAt: now() });
    record('tool', `Started ${toolName}`); publish();
  });
  on('tool_execution_end', (event) => {
    if (key(event.toolCallId)) tools.delete(idFor('tool', event.toolCallId));
    record('tool', `${event.isError ? 'Failed' : 'Finished'} ${name(event.toolName) ?? 'tool'}`);
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
    tools.clear(); record('session', 'Session closed'); publish(); stop();
  });
}

export default function activityBridge(pi) { installActivityBridge(pi); }

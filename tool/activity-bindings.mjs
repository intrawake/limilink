/** Passive role evidence, never a source of graph nodes. Only exact session files
 * in public tool results or explicitly announced, owned run status are admitted.
 */
import { constants, openSync, closeSync, fstatSync, readSync, lstatSync, realpathSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { key, name, idFor, keyedIdFor, safeCount } from './activity-metadata.mjs';

export const bindingId = value => typeof value === 'string' && /^binding:[0-9a-f]{32}$/.test(value);
const safeFile = value => typeof value === 'string' && isAbsolute(value) && value.length <= 4096 && !/[\x00-\x1f\x7f]/.test(value);
const safeOwned = info => info.uid === process.getuid() && (info.mode & 0o022) === 0;
const STATUS_BYTES = 256 * 1024;
export function roleFacts(value, limit) {
  if (!Array.isArray(value) || value.length > limit || value.some(row => !bindingId(row?.id)
      || !/^file:[0-9a-f]{32}$/.test(row?.fileKey ?? '') || !(row.agent === null || name(row.agent)))) return null;
  return value.map(({id,fileKey,agent}) => ({id,fileKey,agent}));
}
function readStatus(directory) {
  if (realpathSync(directory) !== directory) return null;
  const parent = lstatSync(directory);
  if (!parent.isDirectory() || !safeOwned(parent)) return null;
  const fd = openSync(join(directory, 'status.json'), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const info = fstatSync(fd);
    if (!info.isFile() || !safeOwned(info) || info.size > STATUS_BYTES) return null;
    const buffer = Buffer.alloc(STATUS_BYTES + 1), count = readSync(fd, buffer);
    return count <= STATUS_BYTES ? JSON.parse(buffer.subarray(0, count).toString('utf8')) : null;
  } finally { closeSync(fd); }
}

/** Negative evidence is monotonic across collector lifetimes and reclamation. */
export function createRoleLedger(limit = 256, initial) {
  const claims = new Map();
  let limited = false;
  const merge = value => {
    const facts = roleFacts(value?.bindings ?? [], limit);
    if (!facts || value?.bindingsLimited) limited = true;
    for (const fact of facts ?? []) {
      const old = claims.get(fact.id);
      if (old && (old.fileKey !== fact.fileKey || old.agent !== fact.agent)) {
        old.agent = null;
        const id = idFor('binding', fact.id, fact.fileKey);
        if (claims.size < limit || claims.has(id)) claims.set(id, {...fact,id,agent:null});
        else limited = true;
      } else if (!old) {
        if (claims.size >= limit) limited = true; else claims.set(fact.id, {...fact});
      }
    }
  };
  if (initial) merge(initial);
  return {merge,snapshot:()=>({bindings:limited?[]:[...claims.values()].map(fact=>({...fact})),bindingsLimited:limited})};
}

export function createRoleBindings(config, options = {}) {
  const now = options.now ?? Date.now, limit = options.limit ?? 256;
  const ledger = createRoleLedger(limit, options.initial), runs = new Map();
  let lastRead = -Infinity;
  const uncertain = () => ledger.merge({bindingsLimited:true});
  const owner = value => value === config.file || value === config.uuid;
  const fileKey = file => keyedIdFor(config.token, 'file', file);
  const bind = (launch, child, file, agent) => {
    if (!key(launch) || !key(child) || !safeFile(file) || file === config.file || !name(agent)) return;
    const id = keyedIdFor(config.token, 'binding', config.file, config.uuid, launch, child);
    const fact = {id, fileKey:fileKey(file), agent};
    ledger.merge({bindings:[fact]});
  };
  const admit = (runId, asyncDir) => {
    if (!key(runId) || !safeFile(asyncDir)) return;
    try {
      const directory = realpathSync(asyncDir), info = lstatSync(directory);
      if (!info.isDirectory() || !safeOwned(info)) return;
      const old = runs.get(runId);
      if (old && old.directory !== directory) { old.conflict = true; uncertain(); return; }
      if (!old) {
        if (runs.size >= Math.min(limit, 64)) { uncertain(); return; }
        runs.set(runId, {directory});
      }
    } catch { /* A missing launch artifact is not a reason to search for it. */ }
  };
  return {
    merge: ledger.merge,
    started(data) {
      if (owner(data?.sessionId)) admit(data.id, data.asyncDir);
    },
    tool(event, partial = false) {
      if (event.toolName !== 'subagent') return;
      const result = partial ? event.partialResult : event.result;
      const details = result?.details;
      if (!details || typeof details !== 'object') return;
      // This callback belongs to the exact originating session and tool call.
      if (key(details.asyncId)) admit(details.asyncId, details.asyncDir);
      else if (key(details.runId)) admit(details.runId, details.asyncDir);
      if (!Array.isArray(details.results)) return;
      if (details.results.length > 64) { uncertain(); return; }
      for (const row of details.results) {
        const run = key(row?.runId) ? row.runId : details.runId;
        const child = name(row?.workflowKey) ?? (safeCount(row?.index) ? String(row.index) : null);
        if (child) bind(run, child, row.sessionFile, row.agent);
      }
    },
    snapshot() {
      // Reuse the owning observer's heartbeat. No recursive discovery or extra timers.
      if (now() - lastRead >= 1000 || now() < lastRead) {
        lastRead = now();
        for (const [runId, run] of runs) {
          if (run.conflict) continue;
          try {
            const data = readStatus(run.directory);
            if (!data || data.lifecycleArtifactVersion !== 3 || data.runId !== runId || !owner(data.sessionId)
                || !Array.isArray(data.steps)) continue;
            if (data.steps.length > 64) { uncertain(); continue; }
            data.steps.forEach((step, index) => {
              const child = name(step?.workflowKey) ?? (key(step?.runId) ? step.runId : String(index));
              bind(runId, child, step?.sessionFile, step?.agent);
            });
            if (['complete', 'failed', 'partial', 'paused', 'stopped', 'rejected'].includes(data.state)) runs.delete(runId);
          } catch { /* Missing, stale, replaced or oversized artifacts add no role evidence. */ }
        }
      }
      return ledger.snapshot();
    },
  };
}

/** Small, shared metadata-only validators/formatters. Never inspect content. */
import { createHash, createHmac, randomUUID } from 'node:crypto';
import { writeFileSync, renameSync, unlinkSync } from 'node:fs';

export const finite = n => typeof n === 'number' && Number.isFinite(n) && n >= 0;
export const name = s => typeof s === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,95}$/.test(s) ? s : null;
export const modelName = s => typeof s === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_.:/-]{0,127}$/.test(s) && !s.includes('://') ? s : null;
export function observedModel(value) {
  const id = modelName(value?.model ?? value?.id), provider = name(value?.provider);
  if (!id) return null;
  return provider && !id.startsWith(`${provider}/`) ? modelName(`${provider}/${id}`) ?? id : id;
}
export const key = s => typeof s === 'string' && s.length > 0 && s.length <= 1024;
export const idFor = (namespace, ...parts) => `${namespace}:${createHash('sha256').update(JSON.stringify(parts)).digest('hex').slice(0, 32)}`;
export const keyedIdFor = (token, namespace, ...parts) => `${namespace}:${createHmac('sha256', token).update(JSON.stringify(parts)).digest('hex').slice(0, 32)}`;
export const safeCount = n => Number.isSafeInteger(n) && n >= 0;
const tokenCount = new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 });

export function contextUsage(usage, at) {
  if (!usage || !finite(usage.contextWindow) || usage.contextWindow <= 0) return null;
  const tokens = finite(usage.tokens) ? usage.tokens : null;
  return { tokens, contextWindow: usage.contextWindow,
    percent: tokens !== null && finite(usage.percent) ? usage.percent : null, observedAt: at, basis: 'estimate' };
}

/** Categories are separate; all-zero initialized usage is not free work. */
export function usageLabel(usage, label) {
  const count = n => safeCount(n) ? tokenCount.format(n).replace(/K$/, 'k') : '?';
  const reported = ['input', 'output', 'cacheRead', 'cacheWrite'].some(field => safeCount(usage?.[field]) && usage[field] > 0);
  if (!reported) return `${label} · usage not reported`;
  const write = usage.cacheWrite === 0 ? '' : ` · write ${count(usage.cacheWrite)}`;
  return `${label} · cached ${count(usage.cacheRead)} · in ${count(usage.input)} · out ${count(usage.output)}${write}`;
}

export function responseUsageLabel(message) {
  const status = message?.stopReason === 'error' ? ' (error)' : message?.stopReason === 'aborted' ? ' (aborted)' : '';
  return usageLabel(message?.usage, `Model${status}`);
}

/** Same-directory atomic replacement, never partial JSON. Trusted directory only. */
export function writeAtomicSnapshot(path, snapshot, temporary = `${path}.${process.pid}.${randomUUID()}.tmp`) {
  try {
    writeFileSync(temporary, `${JSON.stringify(snapshot)}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    renameSync(temporary, path);
  } finally {
    try { unlinkSync(temporary); } catch { /* already renamed or creation failed */ }
  }
}

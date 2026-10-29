import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

// Execute the real controller's state functions without DOM wiring/startup.
// Browser coverage exercises the full controller and actual saved receipts.
async function controller(name) {
  const source = await readFile(new URL(`../src/ui/${name}.js`, import.meta.url), 'utf8');
  const start = source.indexOf("\nbyId('new-session-btn').addEventListener");
  assert.ok(start > 0);
  const context = vm.createContext({
    document: { getElementById: () => ({ addEventListener() {} }), addEventListener() {}, visibilityState: 'visible' },
    window: { matchMedia: () => ({ matches: false }), addEventListener() {} },
    AbortController, URLSearchParams, setTimeout, clearTimeout,
  });
  vm.runInContext(source.slice(0, start), context);
  vm.runInContext(`
    let renders = 0, warnings = 0;
    renderSessions = () => { renders++; };
    showUnconfirmed = () => {};
    notice = () => { warnings++; };
    sessions = [{ id: 'session_a' }, { id: 'session_b' }, { id: 'session_c' }];
    currentSession = 'session_c'; connected = true; historyReady = true;
    function submission(id) { return { id, text: 'Preserved text ' + id, needsRecovery: false, accepted: false, settled: false }; }
  `, context);
  return code => vm.runInContext(code, context);
}

const name = 'follow';

  test(`${name}: bounded fair offscreen receipt rotation, no unrelated activity/cache mutation`, async () => {
const run = await controller(name);
await run(`(async () => {
  const missing = submission('a0'), later = submission('a1'), failed = submission('b0');
  unconfirmedSends.set('session_a', [missing, later]); addPending('session_b', failed);
  serverBusy.add('session_c');
  let calls = [];
  api = async path => {
    const id = new URLSearchParams(path.split('?')[1]).get('request_id'); calls.push(id);
    return { revision: 'r', busy: false, busy_sessions: [], send: { id,
      state: id === 'a0' ? 'missing' : 'complete',
      outcome: id === 'b0' ? { status: 429, body: { detail: 'Refused' } } : { status: 200, body: { reply: 'Saved' } } } };
  };
  await syncBackgroundReceipt();
  if (calls.length !== 1 || renders !== 0) throw Error('Unchanged missing receipt caused extra work/render');
  await syncBackgroundReceipt(); await syncBackgroundReceipt();
  if (calls.join(',') !== 'a0,b0,a1') throw Error('Session or saved-ID rotation starved: ' + calls);
  if (pendingSends.size || unconfirmedSends.get('session_a')?.length !== 1 || unconfirmedSends.get('session_a')[0] !== missing
      || !unconfirmedSends.get('session_b')?.[0].failed) throw Error('Exact outcomes not preserved');
  if (!serverBusy.has('session_c') || historyCache.size || currentSession !== 'session_c' || !connected || !historyReady) throw Error('Selected state/cache changed');
})()`);
  });

  test(`${name}: concurrent checks coalesce, pause cancels, late response cannot reconcile`, async () => {
const run = await controller(name);
await run(`(async () => {
  const send = submission('a0'); addPending('session_a', send);
  let calls = 0, release, signal;
  api = (path, options) => { calls++; signal = options.signal; return new Promise(resolve => { release = resolve; }); };
  const first = syncBackgroundReceipt(), second = syncBackgroundReceipt();
  if (calls !== 1) throw Error('Concurrent extra GETs');
  pauseUpdates();
  if (!signal.aborted || activeReceiptCheck !== null || pollTimer !== null || !send.needsRecovery) throw Error('Pause did not cancel lifecycle');
  release({ revision: 'r', busy: false, send: { id: 'a0', state: 'complete', outcome: { status: 200, body: { reply: 'Saved' } } } });
  if (await first || await second || !isPending('session_a', send) || renders) throw Error('Cancelled response mutated state');
  document.visibilityState = 'hidden';
  await syncBackgroundReceipt();
  if (calls !== 1) throw Error('Hidden page started extra GET');
})()`);
  });

  test(`${name}: malformed/mismatched receipts and GET errors never imply completion`, async () => {
const run = await controller(name);
await run(`(async () => {
  const send = submission('a0'); addPending('session_a', send);
  api = async () => ({ revision: 'r', busy: false, send: { id: 'other', state: 'complete', outcome: { status: 200, body: { reply: 'Not ours' } } } });
  await syncBackgroundReceipt();
  if (!isPending('session_a', send) || deliveryStatus('session_a') !== 'Sending…') throw Error('Wrong ID acknowledged or idle means working');
  api = async () => ({ revision: 'r', busy: false, send: { id: 'a0', state: 'complete', outcome: { status: 200, body: {} } } });
  if (await syncBackgroundReceipt()) throw Error('Malformed complete receipt accepted');
  api = async () => { throw Error('Network unavailable'); };
  await syncBackgroundReceipt();
  if (!isPending('session_a', send) || unconfirmedSends.size || !connected || !historyReady || warnings) throw Error('Offscreen error changed selected/delivery state');
})()`);
  });

  test(`${name}: changed selection or dismissed candidate wins over an old GET`, async () => {
const run = await controller(name);
for (const action of ['currentSession = "session_a"', 'unconfirmedSends.delete("session_a")']) {
  await run(`(async () => {
    currentSession = 'session_c';
    const send = submission('a0'); unconfirmedSends.set('session_a', [send]);
    let release;
    api = () => new Promise(resolve => { release = resolve; });
    const checking = syncBackgroundReceipt();
    ${action};
    release({ revision: 'r', busy: false, send: { id: 'a0', state: 'complete', outcome: { status: 429, body: { detail: 'Old failure' } } } });
    if (await checking || send.failed || warnings || renders) throw Error('Obsolete offscreen reply mutated state');
    unconfirmedSends.clear();
  })()`);
}
  });

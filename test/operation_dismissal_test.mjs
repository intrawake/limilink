import assert from 'node:assert/strict';
import test from 'node:test';
import { controller, operation } from './delivery_controller.mjs';

const posts = ui => ui.calls.filter(call => call.options.method === 'POST');
const gets = ui => ui.calls.filter(call => !call.options.method);
const failed = call => operation(call, 'failed', 2, { outcome: { status: 500, body: { detail: 'failure' } } });
async function rediscover(ui, operations) {
    ui.run('void syncOperations();');
    gets(ui).at(-1).respond({ operations });
    await ui.flush();
}

for (const action of ['dismiss-unconfirmed', 'restore-unconfirmed']) {
    test(`${action} survives reload and default server rediscovery without retaining dismissed text`, async () => {
        const first = await controller();
        const text = 'Discard this exact attempted text';
        await first.send('x', text);
        const op = failed(posts(first)[0]);
        posts(first)[0].respond({ operation: op }, 202);
        await first.flush();
        first.node('message-input').value = 'Keep newer draft';
        first.node(action).click();
        assert.equal(first.node('unconfirmed-send').hidden, true);
        assert.equal(first.node('message-input').value, action === 'restore-unconfirmed' ? `Keep newer draft\n\n${text}` : 'Keep newer draft');
        assert.equal(JSON.stringify([...first.saved.values()]).includes(text), false, 'Discard must not retain full message text');
        const reloaded = await controller(first.saved);
        reloaded.run('restoreOperations(); showUnconfirmed();');
        await rediscover(reloaded, [op]);
        assert.equal(reloaded.node('unconfirmed-send').hidden, true, 'Default operation GET resurrected explicitly discarded text');
        assert.equal(reloaded.node('unconfirmed-text').textContent, '');
        assert.equal(posts(reloaded).length, 0);
        assert.equal(reloaded.events.length, 0);
        assert.equal(posts(first).length, 1, 'Restore/dismiss must never POST');
        assert.ok(first.saved.size > 0, 'Exact identity dismissal must remain durable');
    });
}

test('dismissal wins over an independent tab’s late GET and stale storage writes', async () => {
    const first = await controller();
    await first.send('x', 'Dismiss across tabs');
    const op = failed(posts(first)[0]);
    posts(first)[0].respond({ operation: op }, 202);
    await first.flush();
    const second = await controller(first.saved);
    second.run('restoreOperations(); showUnconfirmed(); void syncOperations();');
    assert.equal(second.node('unconfirmed-send').hidden, false);
    first.node('dismiss-unconfirmed').click();
    // A stale tab must not replace the durable discard with its old full record.
    second.run('persistOperations();');
    gets(second)[0].respond({ operations: [{ ...op, revision: 3 }] });
    await second.flush();
    second.run('showUnconfirmed();');
    assert.equal(second.node('unconfirmed-send').hidden, true);
    assert.equal(JSON.stringify([...first.saved.values()]).includes(op.message), false);
    const reloaded = await controller(first.saved);
    reloaded.run('restoreOperations();');
    await rediscover(reloaded, [op]);
    assert.equal(reloaded.node('unconfirmed-send').hidden, true);
    assert.equal(posts(second).length + posts(reloaded).length, 0);
});

test('durable dismissal is exact-ID/session scoped, not a same-text suppression', async () => {
    const first = await controller();
    await first.send('x', 'Identical text');
    const op = failed(posts(first)[0]);
    posts(first)[0].respond({ operation: op }, 202);
    await first.flush();
    first.node('dismiss-unconfirmed').click();
    const reloaded = await controller(first.saved);
    reloaded.run('restoreOperations();');
    const sibling = { ...op, id: 'b'.repeat(32), sequence: 1 };
    await rediscover(reloaded, [op, sibling]);
    assert.equal(reloaded.node('unconfirmed-text').textContent, op.message, 'Different ID with identical text must remain recoverable');
    reloaded.node('dismiss-unconfirmed').click();
    reloaded.run("currentSession='y';");
    await rediscover(reloaded, [{ ...op, session_id: 'y' }]);
    assert.equal(reloaded.node('unconfirmed-text').textContent, op.message, 'Same ID in another session must remain recoverable');
    assert.equal(posts(reloaded).length, 0);
});

test('dismissal tombstones free retained-text capacity without removing its normal bound', async () => {
    const first = await controller();
    for (let i = 0; i < 64; i++) {
        await first.send('x', 'Discard ' + i);
        posts(first).at(-1).respond({ operation: failed(posts(first).at(-1)) }, 202);
        await first.flush();
    }
    first.node('dismiss-unconfirmed').click();
    assert.equal(first.node('unconfirmed-send').hidden, true);
    const reloaded = await controller(first.saved);
    reloaded.run("restoreOperations(); let fresh=100; newSendId=()=> (++fresh).toString(16).padStart(32,'0');");
    for (let i = 0; i < 64; i++) {
        await reloaded.send('x', 'Retain ' + i);
        assert.equal(posts(reloaded).length, i + 1, 'Dismissal consumed retained-text capacity');
        posts(reloaded).at(-1).respond({ detail: 'Queue full' }, 429);
        await reloaded.flush();
    }
    await reloaded.send('x', 'Keep bounded draft');
    assert.equal(posts(reloaded).length, 64);
    assert.equal(reloaded.node('message-input').value, 'Keep bounded draft');
    assert.match(reloaded.node('notice').textContent, /local saved-message limit/);
});

test('a durable dismissal dominates a stale full record in either storage enumeration order', async () => {
    for (const reverse of [false, true]) {
        const first = await controller();
        await first.send('x', 'Remove stale text too');
        const op = failed(posts(first)[0]);
        posts(first)[0].respond({ operation: op }, 202);
        await first.flush();
        const staleEntries = [...first.saved.entries()];
        first.node('dismiss-unconfirmed').click();
        const markerEntries = [...first.saved.entries()];
        const saved = new Map(reverse ? [...markerEntries, ...staleEntries] : [...staleEntries, ...markerEntries]);
        const reloaded = await controller(saved);
        reloaded.run('restoreOperations(); showUnconfirmed();');
        await rediscover(reloaded, [op]);
        assert.equal(reloaded.node('unconfirmed-send').hidden, true);
        assert.equal(JSON.stringify([...saved.values()]).includes(op.message), false, 'Stale full text must be purged on restore');
        assert.equal(posts(reloaded).length, 0);
    }
});

test('dismissing unknown admission remains durable when a late accepted operation eventually fails', async () => {
    const first = await controller();
    await first.send('x', 'Discard unknown attempt');
    posts(first)[0].reject(new Error('Lost admission response'));
    await first.flush();
    first.node('dismiss-unconfirmed').click();
    const reloaded = await controller(first.saved);
    reloaded.run('restoreOperations(); showUnconfirmed();');
    await rediscover(reloaded, [operation(posts(first)[0], 'running', 1)]);
    assert.equal(reloaded.node('unconfirmed-send').hidden, true);
    assert.equal(reloaded.node('typing').hidden, true);
    await rediscover(reloaded, [failed(posts(first)[0])]);
    assert.equal(reloaded.node('unconfirmed-send').hidden, true);
    assert.equal(posts(reloaded).length, 0);
    assert.equal(reloaded.events.length, 0);
});

test('a stale independent tab cannot reuse a durable discarded identity for a new send', async () => {
    const first = await controller();
    await first.send('x', 'Discarded intent');
    posts(first)[0].respond({ operation: failed(posts(first)[0]) }, 202);
    await first.flush();
    const second = await controller(first.saved);
    first.node('dismiss-unconfirmed').click();
    await second.send('x', 'Keep new colliding draft');
    assert.equal(second.node('message-input').value, 'Keep new colliding draft');
    assert.equal(posts(second).length, 0);
    assert.equal(second.events.length, 0);
    assert.match(second.node('notice').textContent, /could not safely identify/);
    second.run("newSendId=()=> 'b'.repeat(32);");
    await second.send('x', 'Fresh independent intent');
    assert.equal(posts(second).length, 1);
});

test('unavailable dismissal storage warns explicitly rather than promising reload suppression', async () => {
    const ui = await controller();
    await ui.send('x', 'Discard with blocked storage');
    posts(ui)[0].respond({ operation: failed(posts(ui)[0]) }, 202);
    await ui.flush();
    ui.run("localStorage.setItem=()=>{throw Error('quota');};");
    ui.node('dismiss-unconfirmed').click();
    assert.equal(ui.node('unconfirmed-send').hidden, true);
    assert.match(ui.node('notice').textContent, /Dismissal could not be saved.*may reappear after reload/);
    assert.equal(posts(ui).length, 1);
});

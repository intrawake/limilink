import assert from 'node:assert/strict';
import test from 'node:test';
import { controller, operation } from './delivery_controller.mjs';

const posts = ui => ui.calls.filter(call => call.options.method === 'POST');
const gets = ui => ui.calls.filter(call => !call.options.method);

// Old snapshot-send receipt tests are replaced with public operation-list GETs.
test('bounded fair offscreen state rotation never requests history or mutates selected activity', async () => {
    const ui = await controller();
    for (const id of ['x', 'y']) {
        await ui.send(id, 'Work in ' + id);
        posts(ui).at(-1).respond({ operation: operation(posts(ui).at(-1), 'running') }, 202);
        await ui.flush();
    }
    ui.run("currentSession='z'; serverBusy.add('z');");
    for (let i = 0; i < 4; i++) {
        ui.run('void syncBackgroundOperations();');
        await ui.flush();
        gets(ui).at(-1).respond({ operations: [operation(posts(ui)[i % 2], 'running')] });
        await ui.flush();
    }
    assert.deepEqual(gets(ui).map(call => call.path), ['/sessions/x/operations', '/sessions/y/operations', '/sessions/x/operations', '/sessions/y/operations']);
    assert.equal(ui.run("currentSession==='z' && serverBusy.has('z') && connected && historyReady && historyCache.size===0"), true);
});

test('concurrent GETs coalesce; pause cancels, hidden page and late responses cannot reconcile', async () => {
    const ui = await controller();
    await ui.send('x', 'work');
    posts(ui)[0].respond({ operation: operation(posts(ui)[0]) }, 202);
    await ui.flush();
    ui.run("currentSession='z'; void syncBackgroundOperations(); void syncBackgroundOperations();");
    assert.equal(gets(ui).length, 1);
    ui.run('pauseUpdates();');
    assert.equal(gets(ui)[0].options.signal.aborted, true);
    gets(ui)[0].respond({ operations: [operation(posts(ui)[0], 'failed', 2, { outcome: { status: 429, body: { detail: 'late' } } })] });
    await ui.flush();
    ui.run("document.visibilityState='hidden'; void syncBackgroundOperations(); currentSession='x'; showUnconfirmed();");
    assert.equal(gets(ui).length, 1);
    assert.equal(ui.node('unconfirmed-send').hidden, true);
});

test('malformed, cross-session and GET errors never imply completion or disconnect selected history', async () => {
    const ui = await controller();
    await ui.send('x', 'keep');
    posts(ui)[0].respond({ operation: operation(posts(ui)[0]) }, 202);
    await ui.flush();
    ui.run("currentSession='z';");
    for (const response of [
        { operations: [operation(posts(ui)[0], 'succeeded', 2, { session_id: 'y', outcome: { status: 200, body: { reply: 'wrong' } } })] },
        { operations: [operation(posts(ui)[0], 'succeeded', 2, { outcome: { status: 200, body: {} } })] },
    ]) {
        ui.run('void syncBackgroundOperations();');
        gets(ui).at(-1).respond(response);
        await ui.flush();
    }
    ui.run('void syncBackgroundOperations();');
    gets(ui).at(-1).reject(new Error('offline'));
    await ui.flush();
    assert.equal(ui.run("connected && historyReady && currentSession==='z'"), true);
    ui.run("currentSession='x'; updateInputState(); showUnconfirmed();");
    assert.equal(ui.node('typing').textContent, 'Queued');
    assert.equal(ui.node('unconfirmed-send').hidden, true);
});

test('navigation and dismissed candidates win over an old operation GET', async () => {
    const ui = await controller();
    await ui.send('x', 'uncertain');
    posts(ui)[0].reject(new Error('lost'));
    await ui.flush();
    ui.run("currentSession='z'; void syncBackgroundOperations(); navigationVersion++; currentSession='x';");
    gets(ui)[0].respond({ operations: [operation(posts(ui)[0], 'failed', 2, { outcome: { status: 429, body: { detail: 'old' } } })] });
    await ui.flush();
    ui.run('showUnconfirmed();');
    assert.match(ui.node('saved-send-status').textContent, /unknown/);
    ui.run('void syncOperations(); dismissRecoverable(recoverableForView()); showUnconfirmed();');
    gets(ui).at(-1).respond({ operations: [operation(posts(ui)[0], 'failed', 2, { outcome: { status: 429, body: { detail: 'dismissed' } } })] });
    await ui.flush();
    assert.equal(ui.node('unconfirmed-send').hidden, true);
    assert.equal(posts(ui).length, 1);
});

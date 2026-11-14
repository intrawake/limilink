import assert from 'node:assert/strict';
import test from 'node:test';
import { controller, operation } from './delivery_controller.mjs';

const posts = ui => ui.calls.filter(call => call.options.method === 'POST');
const gets = ui => ui.calls.filter(call => !call.options.method);

// Established red against 89873263 before replacing /chat and its global cap.
test('two busy X operations cannot block a new Y admission', async () => {
    const ui = await controller();
    await ui.send('x', 'first');
    posts(ui)[0].respond({ operation: operation(posts(ui)[0], 'running') }, 202);
    await ui.flush();
    await ui.send('x', 'second');
    posts(ui)[1].respond({ operation: operation(posts(ui)[1]) }, 202);
    await ui.flush();
    await ui.send('y', '!agent pi');
    assert.equal(posts(ui).length, 3);
    assert.equal(posts(ui)[2].path, '/sessions/y/operations');
    assert.equal(ui.node('message-input').value, '');
});

test('rapid clicks serialize short admissions, not execution, and preserve exact text/IDs', async () => {
    const ui = await controller();
    await ui.send('x', '  same\n');
    await ui.send('x', '  same\n');
    assert.equal(posts(ui).length, 1, 'successor must wait for preceding acceptance');
    assert.equal(ui.node('typing').textContent, 'Sending…');
    posts(ui)[0].respond({ operation: operation(posts(ui)[0], 'running') }, 202);
    await ui.flush();
    assert.equal(posts(ui).length, 2, 'acceptance releases successor without waiting for execution');
    assert.equal(posts(ui)[0].body.message, '  same\n');
    assert.equal(posts(ui)[1].body.message, '  same\n');
    assert.notEqual(posts(ui)[0].body.request_id, posts(ui)[1].body.request_id);
    posts(ui)[1].respond({ operation: operation(posts(ui)[1]) }, 202);
    await ui.flush();
    assert.equal(ui.events.length, 2);
});

for (const failure of ['network', 'timeout', 'indeterminate']) {
    test(`${failure} leaves admission unknown and staged successors explicitly unsent, even after recovery`, async () => {
        const ui = await controller();
        await ui.send('x', 'attempted');
        await ui.send('x', 'later staged');
        // Identity/text are durable before transport; transient staging is not an outbox.
        const saved = [...ui.saved.values()].map(value=>JSON.parse(value));
        assert.equal(saved[0].id, posts(ui)[0].body.request_id);
        assert.equal(saved[0].text, 'attempted');
        assert.equal(saved[0].attempted, true);
        if (failure === 'network') posts(ui)[0].reject(new Error('lost acceptance'));
        if (failure === 'timeout') [...ui.timers.values()][0]();
        if (failure === 'indeterminate') posts(ui)[0].respond({ detail: 'Unreadable identity', code: 'send_indeterminate' }, 409);
        await ui.flush();
        assert.equal(posts(ui).length, 1);
        assert.match(ui.node('saved-send-status').textContent, /unknown.*staged messages were not sent/);
        assert.match(ui.node('unconfirmed-text').textContent, /attempted[\s\S]*later staged/);
        ui.run('void syncOperations();');
        gets(ui).at(-1).respond({ operations: [operation(posts(ui)[0], 'running', 1)] });
        await ui.flush();
        assert.equal(posts(ui).length, 1, 'GET recovery must not release unsent successor');
        assert.equal(ui.node('unconfirmed-text').textContent, 'later staged');
        assert.match(ui.node('saved-send-status').textContent, /Not sent/);
        assert.equal(ui.events.length, 2, 'GET must not re-emit human-send');
    });
}

test('reload preserves attempted identity and staged text, performs GET only, never posts saved messages', async () => {
    const first = await controller();
    await first.send('x', 'attempted before reload');
    await first.send('x', 'staged before reload');
    const ui = await controller(first.saved);
    ui.run('restoreOperations(); showUnconfirmed(); void syncOperations();');
    assert.equal(posts(ui).length, 0);
    assert.match(ui.node('unconfirmed-text').textContent, /attempted before reload[\s\S]*staged before reload/);
    gets(ui)[0].respond({ operations: [] });
    await ui.flush();
    assert.equal(gets(ui).length, 2);
    const query = new URLSearchParams(gets(ui)[1].path.split('?')[1]);
    assert.deepEqual(query.getAll('request_id'), [posts(first)[0].body.request_id]);
    gets(ui)[1].respond({ operations: [] });
    await ui.flush();
    ui.run('pumpAdmissions("x");');
    assert.equal(posts(ui).length, 0);
    assert.equal(ui.node('send-btn').disabled, false);
});

test('reload recovers accepted queued/running work without resubmission', async () => {
    const first = await controller();
    await first.send('x', 'accepted');
    posts(first)[0].respond({ operation: operation(posts(first)[0]) }, 202);
    await first.flush();
    const ui = await controller(first.saved);
    ui.run('restoreOperations(); void syncOperations();');
    gets(ui)[0].respond({ operations: [operation(posts(first)[0], 'running', 1)] });
    await ui.flush();
    assert.equal(posts(ui).length, 0);
    assert.equal(ui.node('typing').textContent, 'Thinking…');
    assert.equal(ui.node('unconfirmed-send').hidden, true);
});

test('queued is not running; stale GET revision cannot overwrite a newer admission result', async () => {
    const ui = await controller();
    await ui.send('x', 'queued');
    ui.run('void syncOperations();');
    posts(ui)[0].respond({ operation: operation(posts(ui)[0], 'running', 2) }, 202);
    await ui.flush();
    assert.equal(ui.node('typing').textContent, 'Thinking…');
    gets(ui)[0].respond({ operations: [operation(posts(ui)[0], 'queued', 1)] });
    await ui.flush();
    assert.equal(ui.node('typing').textContent, 'Thinking…');
    ui.run('void syncOperations();');
    gets(ui).at(-1).respond({ operations: [operation(posts(ui)[0], 'succeeded', 3, { outcome: { status: 200, body: { reply: 'done' } } })] });
    await ui.flush();
    assert.equal(ui.node('typing').hidden, true);
    await ui.send('x', 'next');
    posts(ui)[1].respond({ operation: operation(posts(ui)[1]) }, 202);
    await ui.flush();
    assert.equal(ui.node('typing').textContent, 'Queued');
});

test('malformed admission and wrong session/message identities never acknowledge or release successors', async () => {
    for (const bad of [{ session_id: 'y' }, { message: 'different' }, { revision: -1 }, { state: 'succeeded', outcome: null }]) {
        const ui = await controller();
        await ui.send('x', 'original');
        await ui.send('x', 'successor');
        posts(ui)[0].respond({ operation: operation(posts(ui)[0], 'queued', 0, bad) }, 202);
        await ui.flush();
        assert.equal(posts(ui).length, 1);
        assert.match(ui.node('saved-send-status').textContent, /unknown/);
        assert.match(ui.node('unconfirmed-text').textContent, /original[\s\S]*successor/);
    }
});

test('storage failure is visible but never turns into automatic retry', async () => {
    const ui = await controller();
    ui.run("localStorage.setItem=()=>{throw Error('blocked');};");
    await ui.send('x', 'Keep a copy');
    assert.match(ui.node('notice').textContent, /storage is unavailable/);
    posts(ui)[0].reject(new Error('lost'));
    await ui.flush();
    assert.equal(posts(ui).length, 1);
    assert.equal(ui.node('unconfirmed-text').textContent, 'Keep a copy');
});

test('corrupt saved records are not overwritten and never replayed', async () => {
    const saved = new Map([['limilink_operation_v1:x:'+ 'a'.repeat(32), '{broken']]);
    const ui = await controller(saved);
    ui.run('restoreOperations(); recoverMissingSessions();');
    assert.match(ui.node('notice').textContent, /could not be read/);
    assert.equal(saved.get('limilink_operation_v1:x:'+ 'a'.repeat(32)), '{broken');
    assert.equal(posts(ui).length, 0);
});

for (const [state, outcome] of [['cancelled', null], ['interrupted_not_started', { status: 200, body: { reply: 'Not started' } }]]) {
    test(`${state} retains text and is never rendered as success`, async () => {
        const ui = await controller();
        await ui.send('x', 'retain');
        posts(ui)[0].respond({ operation: operation(posts(ui)[0], state, 1, { outcome }) }, 202);
        await ui.flush();
        assert.equal(ui.node('unconfirmed-send').hidden, false);
        assert.equal(ui.node('unconfirmed-text').textContent, 'retain');
        assert.match(ui.node('saved-send-status').textContent, /failed or was not accepted/);
    });
}

test('indeterminate effects remain explicit, preserve staged text and allow targeted stop', async () => {
    const ui = await controller();
    await ui.send('x', '!compact');
    await ui.send('x', 'followup');
    posts(ui)[0].respond({ operation: operation(posts(ui)[0], 'indeterminate', 2) }, 202);
    await ui.flush();
    assert.equal(posts(ui).length, 1);
    assert.equal(ui.node('typing').textContent, 'Effects unknown');
    assert.match(ui.node('saved-send-status').textContent, /effects may already have happened/);
    await ui.send('x', 'Must not bypass');
    assert.equal(posts(ui).length, 1);
    assert.equal(ui.node('message-input').value, 'Must not bypass');
    await ui.send('x', '!stop');
    assert.equal(posts(ui).length, 2);
    assert.equal(posts(ui)[1].body.message, '!stop');
    assert.match(ui.node('unconfirmed-text').textContent, /!compact[\s\S]*followup/);
});

test('metadata-only stop failure keeps the surviving-writer warning visible after GET and empty history', async () => {
    const ui = await controller();
    await ui.send('x', '!stop');
    const call = posts(ui)[0];
    const op = operation(call, 'failed', 2, { execution_id: 'stop-attempt', outcome: { status: 409, body: {
        detail: 'No active execution owned by this service; an earlier writer may still own this session and was not stopped.',
    } } });
    call.respond({ operation: op }, 202);
    await ui.flush();
    ui.run('void syncOperations();');
    gets(ui)[0].respond({ operations: [op] });
    await ui.flush();
    ui.run(`
        globalThis.LimilinkHistory={canonicalSendIds:()=>new Set()};
        historyView={render:(history,local)=>{globalThis.shown={history,local};}};
        serverBusy.add('x');
        renderHistory([],false,new Set([${JSON.stringify(op.id)}]));
        showUnconfirmed(); updateInputState();
    `);
    assert.equal(ui.node('unconfirmed-send').hidden, false);
    assert.match(ui.node('saved-send-status').textContent, /earlier writer[\s\S]*not stopped/);
    assert.equal(ui.node('unconfirmed-text').textContent, '!stop');
    assert.equal(ui.run('shown.history.length+shown.local.length'), 0, 'must not invent unfenced canonical history');
    assert.equal(posts(ui).length, 1, 'warning must not automatically retry stop');
});

test('authoritative GET acceptance releases a lost short response before execution completes', async () => {
    const ui = await controller();
    await ui.send('x', 'first');
    await ui.send('x', 'second');
    ui.run('void syncOperations();');
    gets(ui)[0].respond({ operations: [operation(posts(ui)[0], 'running', 1)] });
    await ui.flush();
    assert.equal(posts(ui).length, 2);
    assert.equal(posts(ui)[0].options.signal.aborted, true);
    assert.equal(ui.node('unconfirmed-send').hidden, true);
    assert.equal(ui.events.length, 2);
});

test('independent tabs cannot overwrite each other’s attempted identity/text journal entries', async () => {
    const saved = new Map();
    const first = await controller(saved), second = await controller(saved);
    second.run("newSendId=()=> 'b'.repeat(32);");
    await first.send('x', 'Tab one attempted');
    await second.send('x', 'Tab two attempted');
    first.calls[0].reject(new Error('lost'));
    await first.flush();
    assert.equal(saved.size, 2);
    const restored = await controller(saved);
    restored.run('restoreOperations(); showUnconfirmed();');
    assert.match(restored.node('unconfirmed-text').textContent, /Tab one attempted[\s\S]*Tab two attempted/);
    assert.equal(posts(restored).length, 0);
});

test('targeted reload reconciliation is bounded to 64 IDs and rotates without starving a saved stop', async () => {
    const saved = new Map();
    for (let index = 1; index <= 65; index++) {
        const id = index.toString(16).padStart(32, '0');
        saved.set('limilink_operation_v1:x:' + id, JSON.stringify({ id, sessionId: 'x', text: index === 65 ? '!stop' : 'Uncertain ' + index,
            state: 'unknown', attempted: true, revision: -1, display: false }));
    }
    const ui = await controller(saved);
    ui.run('restoreOperations(); void syncOperations();');
    gets(ui)[0].respond({ operations: [] }); await ui.flush();
    const first = new URLSearchParams(gets(ui)[1].path.split('?')[1]).getAll('request_id');
    assert.equal(first.length, 64);
    gets(ui)[1].respond({ operations: [] }); await ui.flush();
    ui.run('void syncOperations();');
    gets(ui)[2].respond({ operations: [] }); await ui.flush();
    const second = new URLSearchParams(gets(ui)[3].path.split('?')[1]).getAll('request_id');
    assert.equal(second.length, 64);
    assert.equal(new Set([...first, ...second]).size, 65);
    gets(ui)[3].respond({ operations: [] }); await ui.flush();
    assert.equal(posts(ui).length, 0);
});

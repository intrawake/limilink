import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';
import { controller, operation } from './delivery_controller.mjs';

// Replaces assertions blessing a global two-long-POST cap and independent
// pending/display/uncertain owners. Exercise real send/admission behavior instead.
const posts = ui => ui.calls.filter(call => call.options.method === 'POST');

test('stale snapshots, disconnected reads and busy sessions never disable Send', async () => {
    const ui = await controller();
    ui.run("serverBusy.add('x'); connected=false; historyReady=false; checkingSnapshot=true; updateInputState();");
    assert.equal(ui.node('send-btn').disabled, false);
    assert.equal(ui.node('message-input').disabled, false);
    await ui.send('x', 'Despite stale reads');
    assert.equal(posts(ui).length, 1);
    ui.run('currentSession=null; updateInputState();');
    assert.equal(ui.node('message-input').disabled, true);
    assert.equal(ui.node('send-btn').disabled, false);
});

test('known refusal preserves only exact text, does not overwrite a newer draft, releases ordered admission', async () => {
    const ui = await controller();
    await ui.send('x', 'first');
    await ui.send('x', 'second');
    ui.node('message-input').value = 'Newer draft';
    posts(ui)[0].respond({ detail: 'Queue capacity reached' }, 429);
    await ui.flush();
    assert.equal(posts(ui).length, 2);
    assert.equal(ui.node('message-input').value, 'Newer draft');
    assert.match(ui.node('notice').textContent, /Not accepted.*Queue capacity/);
    assert.equal(ui.node('unconfirmed-text').textContent, 'first');
    posts(ui)[1].respond({ operation: operation(posts(ui)[1], 'succeeded', 2, { outcome: { status: 200, body: { reply: 'done' } } }) }, 202);
    await ui.flush();
    assert.equal(ui.node('unconfirmed-text').textContent, 'first');
    assert.equal(ui.events.length, 2);
});

test('missing target, exhausted retained-text bound and ID generation failure retain the draft without emitting', async () => {
    const ui = await controller();
    await ui.send(null, 'Retain');
    assert.match(ui.node('notice').textContent, /Choose a conversation/);
    assert.equal(ui.node('message-input').value, 'Retain');
    ui.run("newSendId=()=>{throw Error('random unavailable');}");
    await ui.send('x', 'Keep exact draft');
    assert.equal(ui.node('message-input').value, 'Keep exact draft');
    assert.match(ui.node('notice').textContent, /could not safely identify/);
    ui.run("let n=0;newSendId=()=> (++n).toString(16).padStart(32,'0');");
    // Every refusal is a real controlled HTTP response, not injected queue internals.
    for (let i = 0; i < 64; i++) {
        await ui.send('x', 'Saved ' + i);
        posts(ui).at(-1).respond({ detail: 'Full queue' }, 429);
        await ui.flush();
    }
    await ui.send('x', 'Retain at local bound');
    assert.equal(posts(ui).length, 64);
    assert.equal(ui.events.length, 64);
    assert.equal(ui.node('message-input').value, 'Retain at local bound');
    assert.match(ui.node('notice').textContent, /local saved-message limit/);
    await ui.send('x', '!stop');
    assert.equal(posts(ui).length, 65, 'stop keeps a separate retained-text slot');
});

test('same-text intents have distinct exact identities; colliding ID retains the new draft', async () => {
    const ui = await controller();
    await ui.send('x', 'same');
    posts(ui)[0].respond({ operation: operation(posts(ui)[0]) }, 202);
    await ui.flush();
    ui.run(`newSendId=()=>${JSON.stringify(posts(ui)[0].body.request_id)};`);
    await ui.send('x', 'Do not overwrite');
    assert.equal(posts(ui).length, 1);
    assert.equal(ui.node('message-input').value, 'Do not overwrite');
    await ui.send('y', 'same');
    assert.equal(posts(ui).length, 2, 'identity is scoped to session');
});

test('unknown capability never proves optimistic coverage; terminal identity cannot retire a same-text sibling', async () => {
    const ui = await controller();
    await ui.send('x', 'same');
    const first = operation(posts(ui)[0], 'succeeded', 2, { outcome: { status: 200, body: { reply: 'done' } } });
    await ui.send('x', 'same');
    posts(ui)[0].respond({ operation: first }, 202);
    await ui.flush();
    ui.run(`
        let drawn=[]; globalThis.LimilinkHistory={canonicalSendIds:()=>new Set()};
        historyView={render:(history,local)=>{drawn=local.map(item=>item.id);}};
        pinChatToBottom=()=>{};renderHistory([{role:'user',content:'same'}]);
    `);
    assert.deepEqual(Array.from(ui.run('drawn')), posts(ui).map(call => call.body.request_id));
    ui.run(`renderHistory([],true,new Set([${JSON.stringify(first.id)}]));`);
    assert.deepEqual(Array.from(ui.run('drawn')), [posts(ui)[1].body.request_id]);
});

test('removed conversations retain attempted/staged text; explicit dismissal wins over late replies', async () => {
    const ui = await controller();
    await ui.send('x', 'Attempted');
    await ui.send('x', 'Staged');
    ui.run("sessions=[{id:'y'}]; currentSession='y'; recoverMissingSessions();");
    await ui.flush();
    assert.match(ui.node('saved-send-status').textContent, /removed conversations/);
    assert.match(ui.node('unconfirmed-text').textContent, /Attempted[\s\S]*Staged/);
    ui.run('dismissRecoverable(recoverableForView()); showUnconfirmed();');
    posts(ui)[0].respond({ operation: operation(posts(ui)[0], 'failed', 2, { outcome: { status: 429, body: { detail: 'late' } } }) }, 202);
    await ui.flush();
    ui.run('recoverMissingSessions();');
    assert.equal(ui.node('unconfirmed-send').hidden, true);
    assert.equal(posts(ui).length, 1);
});

test('canonical optimistic coverage uses only unique explicit USER IDs; prefix ignores metadata', async () => {
    const source = await readFile(new URL('../src/ui/history-view.js', import.meta.url), 'utf8');
    const context = vm.createContext({ URL }); vm.runInContext(source, context);
    const helper = context.LimilinkHistory, id = 'a'.repeat(32);
    assert.equal(helper.version, 4);
    assert.equal(helper.canonicalSendIds([{role:'bot',content:'same',request_id:id}]).size, 0);
    assert.equal(helper.canonicalSendIds([{role:'user',content:'same',request_id:id}]).has(id), true);
    assert.equal(helper.canonicalSendIds([{role:'user',content:'same',request_id:id},{role:'user',content:'same',request_id:id}]).size, 0);
    assert.equal(helper.canonicalSendIds([{role:'user',content:'same',request_id:'bad'}]).size, 0);
    assert.equal(helper.isPrefix([{role:'user',content:'same'}],[{role:'user',content:'same',request_id:id}]), true);
});

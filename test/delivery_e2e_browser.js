// Disposable delivery_fixture.py only; production owner/adapters, fake local Pi executable.
async page => {
    const base = 'http://127.0.0.1:11018';
    if (!page.url().startsWith(base + '/')) throw Error('Use the disposable delivery fixture.');
    const check = (value, message) => { if (!value) throw Error(message); };
    const errors = [];
    page.on('pageerror', error => errors.push(String(error)));
    const input = page.locator('#message-input');
    const send = async text => { await input.fill(text); await page.locator('#send-btn').click(); };
    const operations = async id => {
        const response = await page.request.get(`${base}/sessions/${id}/operations`);
        check(response.ok(), `Operation status failed for ${id}: ${response.status()}`);
        return (await response.json()).operations;
    };
    const until = async (predicate, label) => {
        const deadline = Date.now() + 15000;
        while (!(await predicate())) {
            if (Date.now() >= deadline) throw Error('Timed out waiting for '+label);
            await page.waitForTimeout(25);
        }
    };
    const waitState = async (id, message, state) => until(async () =>
        (await operations(id)).some(operation => operation.message === message && operation.state === state), `${id}: ${message} -> ${state}`);
    const events = async () => (await (await page.request.get(base + '/__fixture/events')).json()).events;
    const select = async id => {
        await page.locator(`.session-row[data-session-id="${id}"] .session-link`).click();
        await page.waitForFunction(id => document.querySelector('#session-directory').textContent === id, id);
    };
    await page.setViewportSize({width:1280,height:900});
    await page.evaluate(() => {localStorage.clear();sessionStorage.clear();localStorage.setItem('limilink_last_session','session_a');});
    await page.reload();
    await page.waitForFunction(() => document.querySelector('#session-directory').textContent === 'session_a');
    await send('HOLD original A');
    await waitState('session_a', 'HOLD original A', 'running');
    await until(async () => (await events()).some(e => e.message === 'HOLD original A' && e.kind === 'start'), 'fake A process start');
    await send('A queued followup');
    await waitState('session_a', 'A queued followup', 'queued');

    // The reported cross-session failure: two active/queued operations in A must not block new B.
    await page.locator('#new-session-btn').click();
    await page.waitForFunction(() => {const id=document.querySelector('#session-directory').textContent;return id && !['session_a','session_b','session_c'].includes(id);});
    const fresh = await page.locator('#session-directory').textContent();
    await send('!agent pi-b');
    await waitState(fresh, '!agent pi-b', 'succeeded');
    await send('New B can work');
    await waitState(fresh, 'New B can work', 'succeeded');
    const aStillHeld = await operations('session_a');
    check(aStillHeld.find(op => op.message === 'HOLD original A')?.state === 'running', 'Other session accidentally released active A');
    check(aStillHeld.find(op => op.message === 'A queued followup')?.state === 'queued', 'Other session accidentally executed A followup');
    const switchedEvents = await events();
    check(switchedEvents.some(event => event.message === 'New B can work' && event.model === 'model-b' && event.kind === 'start'), 'New-session chat did not observe switched agent model: '+JSON.stringify(switchedEvents));

    // The reported compact race: real acceptance succeeds, but no later writer can start.
    await select('session_c');
    await send('!compact');
    await send('After compact');
    await waitState('session_c', '!compact', 'running');
    await waitState('session_c', 'After compact', 'queued');
    check(!(await events()).some(event => event.message === 'After compact'), 'Chat executed before compact writer settled');
    await page.request.post(base + '/__fixture/release/compact');
    await waitState('session_c', '!compact', 'succeeded');
    await waitState('session_c', 'After compact', 'succeeded');
    const compactEvents = (await events()).filter(event => event.session === 'session_c');
    check(compactEvents.map(event => event.kind+':'+event.message).join('|') === 'start:!compact|finish:!compact|start:After compact|finish:After compact', 'Compact/chat execution trace not strictly ordered');
    await page.reload();
    await page.waitForFunction(() => document.querySelector('#session-directory').textContent === 'session_c');
    check((await operations('session_c')).length === 2, 'Reload created or lost accepted operations');

    // Stop cancels only A's captured writer, allowing its queued successor to execute.
    await select('session_a');
    await send('!stop');
    await waitState('session_a', 'HOLD original A', 'cancelled');
    await waitState('session_a', 'A queued followup', 'succeeded');
    await waitState('session_a', '!stop', 'succeeded');
    const aFinished = await operations('session_a');
    const stop = aFinished.find(op => op.message === '!stop');
    const replay = await page.request.post(`${base}/sessions/session_a/operations`, {data:{request_id:stop.id,message:'!stop'}});
    check(replay.ok(), 'Exact stop replay failed');
    check((await replay.json()).operation.id === stop.id, 'Stop replay changed operation identity');
    check((await operations('session_a')).length === 3, 'Stop replay created another operation');
    const trace = await events();
    check(trace.filter(event => event.message === 'HOLD original A' && event.kind === 'start').length === 1, 'Original A started more than once');
    check(trace.filter(event => event.message === 'A queued followup' && event.kind === 'start').length === 1, 'Queued successor started more than once');
    check(!errors.length, 'Browser exceptions: '+errors.join('; '));
    return {passed:true,providers:0,checks:['cross-session new-session switch/send','turn-time model selection','compact writer exclusion and FIFO','reload no replay','targeted stop preserves successor','exact stop replay'],events:trace};
}

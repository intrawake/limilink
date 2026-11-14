// Actual service integration gate for the disposable --fake-chat fixture only.
// Unlike contract-fake browser tests, this requires the backend operation owner.
async page => {
    const base = 'http://127.0.0.1:11012';
    if (!page.url().startsWith(base + '/')) throw Error('Use the isolated fixture server.');
    const check = (value, message) => { if (!value) throw Error(message); };
    const text = 'Replay-safe operation ' + Date.now().toString(36);
    const posts = [];
    let route, response, seen, done;
    const captured = new Promise(resolve => { seen = resolve; });
    const accepted = new Promise(resolve => { done = resolve; });
    const path = '/sessions/session_a/operations';
    await page.route('**' + path, async requestRoute => {
        if (requestRoute.request().method() !== 'POST') { await requestRoute.continue(); return; }
        posts.push(requestRoute.request().postDataJSON());
        if (posts.length === 1) {
            route = requestRoute; seen(); response = await route.fetch(); done();
        } else await requestRoute.continue();
    });
    try {
        await page.setViewportSize({ width: 1280, height: 900 }); await page.bringToFront();
        await page.evaluate(() => { localStorage.clear(); localStorage.setItem('limilink_last_session', 'session_a'); });
        await page.reload(); await page.waitForFunction(() => currentSession === 'session_a' && historyReady);
        await page.evaluate(() => {
            window.humanSendCount=0;
            document.addEventListener('limilink:human-send', () => humanSendCount++);
        });
        await page.locator('#message-input').fill(text); await page.locator('#send-btn').click(); await captured;
        check(/^[0-9a-f]{32}$/.test(posts[0].request_id), 'No stable random identity');
        const replay = await page.request.post(base + path, { data: posts[0] });
        await accepted;
        check(replay.ok() && response.ok(), 'Duplicate admission failed');
        const original = (await response.json()).operation, duplicate = (await replay.json()).operation;
        // Async state/revision may advance between responses; identity/sequence/payload may not.
        check(original.id === duplicate.id && original.sequence === duplicate.sequence && original.message === duplicate.message, 'Replay allocated a new operation or changed payload');
        await page.locator('#message-input').fill('Keep newer draft');
        await page.evaluate(() => { window.dispatchEvent(new Event('focus')); window.dispatchEvent(new Event('pageshow')); window.dispatchEvent(new Event('online')); });
        await route.abort('failed');
        // waitForFunction does not await a Promise predicate in this harness.
        // Await each status fetch explicitly rather than treating a Promise as true.
        const deadline = Date.now() + 15000;
        while (true) {
            const data = await (await page.request.get(base + path + '/' + original.id)).json();
            if (data.operation?.state === 'succeeded') break;
            if (Date.now() >= deadline) throw Error('Timed out waiting for exact operation completion');
            await page.waitForTimeout(25);
        }
        await page.evaluate(async () => { await syncOperations(); await syncSnapshot({force:true,refreshView:true}); });
        check(await page.locator('#message-input').inputValue() === 'Keep newer draft', 'Recovery overwrote draft');
        const completedReplay = await page.request.post(base + path, { data: posts[0] });
        check(completedReplay.ok() && (await completedReplay.json()).operation.id === original.id, 'Completed replay lost identity');
        const conflict = await page.request.post(base + path, { data: { ...posts[0], message: text + ' conflict' } });
        check(conflict.status() === 409, 'Conflicting payload reuse was accepted');
        let history = await (await page.request.get(base + '/sessions/session_a/history')).json();
        check(history.history.filter(item => item.role === 'user' && item.content === text).length === 1, 'One identity duplicated saved user entries');
        check(history.history.filter(item => item.role === 'bot' && item.content === 'Fixture reply: ' + text).length === 1, 'One identity duplicated saved replies');
        check(posts.length === 1 && await page.evaluate(() => humanSendCount) === 1, 'Recovery automatically resent or emitted human boundary');
        await page.locator('#message-input').fill(text); await page.locator('#send-btn').click();
        await page.waitForFunction(message => [...document.querySelectorAll('.message.bot')].filter(node => node.textContent === 'Fixture reply: ' + message).length === 2, text);
        check(posts.length === 2 && posts[0].request_id !== posts[1].request_id, 'Explicit same-text send reused identity');
        check(await page.evaluate(() => humanSendCount) === 2, 'Explicit second send did not emit exactly once');
        history = await (await page.request.get(base + '/sessions/session_a/history')).json();
        check(history.history.filter(item => item.role === 'user' && item.content === text).length === 2, 'Same text incorrectly deduplicated');
        // Secure-context-independent randomness and its refusal path.
        await page.evaluate(() => Object.defineProperty(crypto, 'getRandomValues', { configurable: true, value: () => { throw Error('fixture random unavailable'); } }));
        await page.locator('#message-input').fill('Keep draft on identity failure'); await page.locator('#send-btn').click();
        check(await page.locator('#message-input').inputValue() === 'Keep draft on identity failure', 'Identity failure lost draft');
        check(posts.length === 2 && (await page.locator('#notice').textContent()).includes('could not safely identify'), 'Identity failure posted or was silent');
        // Exercise a truly insecure HTTP origin, not localhost's exemption.
        const insecureContext = await page.context().browser().newContext();
        const origin = 'http://limilink-fixture.invalid';
        let insecureId, insecurePosts = 0;
        try {
            await insecureContext.route(origin + '/**', async proxy => {
                const request = proxy.request();
                if (request.method() === 'POST' && request.url().split('?')[0].endsWith('/operations')) {
                    insecureId = request.postDataJSON().request_id; insecurePosts++;
                }
                const result = await proxy.fetch({ url: base + request.url().slice(origin.length) });
                await proxy.fulfill({ response: result });
            });
            const phone = await insecureContext.newPage();
            await phone.goto(origin + '/');
            await phone.waitForFunction(() => currentSession && historyReady);
            check(await phone.evaluate(() => isSecureContext) === false, 'Test origin is secure');
            await phone.locator('#message-input').fill('Plain HTTP identity ' + text); await phone.locator('#send-btn').click();
            await phone.waitForFunction(() => !pendingFor(currentSession).length && !trackedFor(currentSession).some(item => item.transport));
            check(insecurePosts === 1 && /^[0-9a-f]{32}$/.test(insecureId), 'Plain HTTP failed to allocate/send one exact ID');
            await phone.evaluate(() => pauseUpdates());
        } finally { await insecureContext.close(); }
        return { passed: true, browserPosts: 2, providers: 0, cases: ['same-ID concurrent/completed admission', 'conflict refusal', 'no transport-loss/recovery replay', 'one saved user/result per ID', 'same-text new intent', 'identity failure preserves draft', 'insecure HTTP randomness'] };
    } finally {
        try { await route?.abort('failed'); } catch {}
        await page.unroute('**' + path);
    }
}

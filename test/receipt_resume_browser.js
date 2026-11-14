// Disposable preview only. Controlled contract state; no service POST forwarding.
async page => {
    const base = 'http://127.0.0.1:11012';
    if (!page.url().startsWith(base + '/')) throw Error('Use the isolated fixture.');
    const check = (value, message) => { if (!value) throw Error(message); };
    const held = [], posts = [], records = new Map();
    let wake;
    const arrival = count => posts.length >= count ? Promise.resolve() : new Promise(resolve => { wake = { count, resolve }; });
    const input = page.locator('#message-input');
    const send = async text => { await input.fill(text); await page.locator('#send-btn').click(); };
    await page.route('**/sessions/*/operations*', async route => {
        const request = route.request();
        if (request.method() === 'POST') {
            held.push(route); posts.push(request.postDataJSON());
            if (wake && posts.length >= wake.count) { wake.resolve(); wake = null; }
        } else {
            const [path, query = ''] = request.url().split('?'), id = path.split('/').at(-2);
            const wanted = query.split('&').filter(pair => pair.startsWith('request_id=')).map(pair => pair.slice('request_id='.length));
            await route.fulfill({ json: { operations: [...records.values()].filter(item => item.session_id === id && (!wanted.length || wanted.includes(item.id))) } });
        }
    });
    try {
        await page.setViewportSize({ width: 1280, height: 900 }); await page.bringToFront();
        await page.evaluate(() => { localStorage.clear(); localStorage.setItem('limilink_last_session', 'session_a'); });
        await page.reload(); await page.waitForFunction(() => currentSession === 'session_a' && historyReady);
        await send('Attempt with lost acceptance'); await arrival(1);
        await send('Later staged, not sent');
        check(posts.length === 1, 'Staged successor sent before acceptance');
        await input.fill('Keep newer draft');
        await held[0].abort('failed');
        await page.locator('#unconfirmed-send').waitFor({ state: 'visible' });
        check((await page.locator('#unconfirmed-text').textContent()).includes('Later staged, not sent'), 'Unsent successor text lost');
        check(await input.inputValue() === 'Keep newer draft', 'Transport loss changed newer draft');
        check((await page.locator('#saved-send-status').textContent()).includes('unknown'), 'Lost admission called safely failed');
        const accepted = { id: posts[0].request_id, session_id: 'session_a', sequence: 0, revision: 1, state: 'running', message: posts[0].message, execution_id: 'fake-execution', outcome: null };
        records.set(accepted.id, accepted);
        await page.evaluate(() => syncOperations());
        check(posts.length === 1, 'GET recovery automatically released an unsent successor');
        check(await page.locator('#unconfirmed-text').textContent() === 'Later staged, not sent', 'Accepted identity failed to reconcile independently');
        check((await page.locator('#saved-send-status').textContent()).includes('Not sent'), 'Held successor not explicitly unsent');
        await page.reload(); await page.waitForFunction(() => currentSession === 'session_a' && historyReady);
        await page.evaluate(() => syncOperations());
        check(posts.length === 1, 'Reload replayed accepted or unsent text');
        check(await page.locator('#unconfirmed-text').textContent() === 'Later staged, not sent', 'Reload lost staged text');
        check((await page.locator('#typing').textContent()) === 'Thinking…', 'Known running operation not recovered');
        await input.fill('Keep restored draft');
        await page.locator('#restore-unconfirmed').click();
        check(await input.inputValue() === 'Keep restored draft\n\nLater staged, not sent', 'Explicit restore overwrote or duplicated draft');
        check(posts.length === 1, 'Restore silently sent');
        // Failed result is retained; stale revision cannot roll it back to running.
        records.set(accepted.id, { ...accepted, state: 'failed', revision: 2, outcome: { status: 500, body: { detail: 'Fixture failure' } } });
        await page.evaluate(() => syncOperations());
        check((await page.locator('#unconfirmed-text').textContent()).includes('Attempt with lost acceptance'), 'Failed outcome discarded original text');
        records.set(accepted.id, accepted);
        await page.evaluate(() => syncOperations());
        check((await page.locator('#unconfirmed-text').textContent()).includes('Attempt with lost acceptance'), 'Stale state cleared failure');
        await page.locator('#dismiss-unconfirmed').click();
        records.set(accepted.id, { ...accepted, state: 'failed', revision: 3, outcome: { status: 500, body: { detail: 'Late failure' } } });
        await page.evaluate(() => syncOperations());
        check(await page.locator('#unconfirmed-send').isHidden(), 'Late GET resurrected dismissed text');
        return { passed: true, posts: posts.length, providers: 0, cases: ['lost admission retains identity/text', 'uncertainty holds successors unsent', 'recovery never auto-releases', 'reload GET only', 'explicit draft restoration', 'failed outcome and stale revision', 'dismissal wins'] };
    } finally {
        await page.evaluate(() => pauseUpdates()).catch(() => {});
        for (const route of held) { try { await route.abort('failed'); } catch {} }
        await page.unroute('**/sessions/*/operations*');
    }
}

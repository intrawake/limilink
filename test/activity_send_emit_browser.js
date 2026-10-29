// Current UI; disposable --fake-chat preview, no real provider.
async page => {
    const base = 'http://127.0.0.1:11012';
    if (!page.url().startsWith(base + '/')) throw new Error('Use the isolated preview.');
    const check = (value, message) => { if (!value) throw new Error(message); };
    const context = await page.context().browser().newContext();
    try {
        const view = await context.newPage();
        await view.addInitScript(() => {
            window.boundaries = [];
            document.addEventListener('limilink:human-send', event => window.boundaries.push(event.detail));
            // Existing Send and the observer both must tolerate blocked storage.
            Storage.prototype.getItem = Storage.prototype.setItem = () => { throw new Error('fixture blocked storage'); };
        });
        let posts = 0, body;
        view.on('request', request => {
            if (request.method() === 'POST' && request.url().endsWith('/chat')) { posts++; body = request.postDataJSON(); }
        });
        await view.goto(base + '/'); await view.waitForSelector('.session-row');
        await view.locator('.session-row[data-session-id="session_b"] .session-link').click();
        await view.waitForFunction(() => currentSession === 'session_b' && historyReady && connected);
        const sent = view.waitForRequest(request => request.method() === 'POST' && request.url().endsWith('/chat'));
        await view.locator('#message-input').fill('Local echo: follow boundary'); await view.locator('#send-btn').click();
        await sent;
        const events = await view.evaluate(() => window.boundaries);
        check(posts === 1 && events.length === 1, 'Duplicate/missing event or POST');
        check(events[0].requestId === body.request_id && events[0].sessionId === 'session_b', 'Wrong captured IDs');
        check(Object.keys(events[0]).sort().join(',') === 'requestId,sessionId', 'Observer event contains content');
        await view.evaluate(() => {
            window.dispatchEvent(new Event('focus')); window.dispatchEvent(new Event('online')); window.dispatchEvent(new Event('pageshow'));
        });
        await view.locator('#send-btn').click(); // Empty input isn't a Send.
        await view.evaluate(() => Object.defineProperty(crypto, 'getRandomValues', { configurable: true, value: () => { throw new Error('fixture RNG unavailable'); } }));
        await view.locator('#message-input').fill('Keep this unsent draft'); await view.locator('#send-btn').click();
        check(await view.locator('#message-input').inputValue() === 'Keep this unsent draft', 'Draft lost');
        check(posts === 1 && await view.evaluate(() => window.boundaries.length) === 1, 'Refresh/invalid Send advanced boundary');
        await view.waitForFunction(() => !pendingSends.has('session_b') && activePosts.size === 0);
        return { passed: true, controller: 'follow', posts, boundaries: events.length, blockedStorage: true, providerCalls: 0 };
    } finally { await context.close(); }
}

// Both retained UI variants; disposable --fake-chat preview, no real provider.
async page => {
    const base = 'http://127.0.0.1:11012';
    if (!page.url().startsWith(base + '/')) throw new Error('Use the isolated preview.');
    const check = (value, message) => { if (!value) throw new Error(message); };
    const results = [];
    for (const variant of ['follow', 'steady']) {
        const context = await page.context().browser().newContext();
        try {
            const view = await context.newPage();
            if (variant === 'steady') {
                // Reproduce cached HTML's retained Rename control, not today's DOM.
                await view.route(base + '/', async route => {
                    const response = await route.fetch();
                    const body = (await response.text()).replace('</body>', '<button id="rename-current" hidden>Rename</button></body>');
                    await route.fulfill({ response, body });
                });
                await view.route('**/follow.js', async route => route.fulfill({ response: await view.request.get(base + '/steady.js') }));
            }
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
            await view.waitForFunction(() => !document.querySelector('#send-btn').disabled);
            await view.locator('#message-input').fill(`Local echo: ${variant} boundary`); await view.locator('#send-btn').click();
            await view.waitForFunction(() => !document.querySelector('#send-btn').disabled);
            const events = await view.evaluate(() => window.boundaries);
            check(posts === 1 && events.length === 1, `${variant}: duplicate/missing event or POST`);
            check(events[0].requestId === body.request_id && events[0].sessionId === 'session_b', `${variant}: wrong captured IDs`);
            check(Object.keys(events[0]).sort().join(',') === 'requestId,sessionId', `${variant}: observer event contains content`);
            await view.evaluate(() => {
                window.dispatchEvent(new Event('focus')); window.dispatchEvent(new Event('online')); window.dispatchEvent(new Event('pageshow'));
            });
            await view.waitForFunction(() => !document.querySelector('#send-btn').disabled);
            await view.locator('#send-btn').click(); // Empty input isn't a Send.
            await view.evaluate(() => Object.defineProperty(crypto, 'getRandomValues', { configurable: true, value: () => { throw new Error('fixture RNG unavailable'); } }));
            await view.locator('#message-input').fill('Keep this unsent draft'); await view.locator('#send-btn').click();
            check(await view.locator('#message-input').inputValue() === 'Keep this unsent draft', `${variant}: draft lost`);
            check(posts === 1 && await view.evaluate(() => window.boundaries.length) === 1, `${variant}: refresh/invalid Send advanced boundary`);
            results.push({ variant, posts, boundaries: events.length, blockedStorage: true });
        } finally { await context.close(); }
    }
    return { passed: true, variants: results, providerCalls: 0 };
}

// Requires tool/sidebar_preview.py --fake-chat. No model/provider requests.
async page => {
    if (!page.url().startsWith('http://127.0.0.1:11012/')) throw new Error('Use the isolated fixture server.');
    const base = 'http://127.0.0.1:11012';
    const run = await page.evaluate(() => Date.now().toString(36));
    const text = `Replay-safe Send ${run}`;
    const check = (value, message) => { if (!value) throw new Error(message); };
    await page.bringToFront();
    await page.reload();
    await page.waitForSelector('.session-row');
    await page.locator('.session-row[data-session-id="session_a"] .session-link').click();
    await page.waitForFunction(() => !document.querySelector('#send-btn').disabled);
    const browserBodies = [];
    await page.evaluate(() => {
        window.humanSendCount = 0;
        document.addEventListener('limilink:human-send', () => window.humanSendCount++);
    });
    let firstRoute, firstResponse, captured, finished;
    const seen = new Promise(resolve => { captured = resolve; });
    const completed = new Promise(resolve => { finished = resolve; });
    await page.route('**/chat', async route => {
        browserBodies.push(route.request().postDataJSON());
        if (browserBodies.length === 1) {
            firstRoute = route;
            captured();
            firstResponse = await route.fetch();
            finished(); // Browser response stays unresolved while server work is complete.
        } else await route.continue();
    });
    await page.locator('#message-input').fill(text);
    await page.locator('#send-btn').click();
    await seen;
    const original = browserBodies[0];
    check(/^[0-9a-f]{32}$/.test(original.request_id), 'Send has no stable random ID');
    const replay = page.request.post(`${base}/chat`, { data: original });
    await page.evaluate(() => {
        Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
        document.dispatchEvent(new Event('visibilitychange'));
    });
    await completed;
    const duplicateResponse = await replay;
    check(duplicateResponse.ok(), 'Concurrent replay did not share the original result');
    check(JSON.stringify(await duplicateResponse.json()) === JSON.stringify(await firstResponse.json()), 'Replayed response differs');
    const later = await page.request.post(`${base}/chat`, { data: original });
    check(later.ok(), 'Completed replay failed');
    await page.evaluate(() => {
        Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' });
        document.dispatchEvent(new Event('visibilitychange'));
        window.dispatchEvent(new Event('focus'));
        window.dispatchEvent(new Event('pageshow'));
        window.dispatchEvent(new Event('online'));
    });
    await page.waitForFunction(message => document.querySelector('#chat-container').textContent.includes(`Fixture reply: ${message}`) && !document.querySelector('#send-btn').disabled, text);
    check(browserBodies.length === 1, 'Returning to the page automatically posted again');
    check(await page.evaluate(() => window.humanSendCount) === 1, 'Receipt replay/recovery advanced the human boundary');
    let saved = await (await page.request.get(`${base}/sessions/session_a/history`)).json();
    check(saved.history.filter(item => item.role === 'user' && item.content === text).length === 1, 'One ID created duplicate saved user entries');
    check(saved.history.filter(item => item.role === 'bot' && item.content === `Fixture reply: ${text}`).length === 1, 'One ID created duplicate saved replies');
    await firstRoute.fulfill({ response: firstResponse });
    await page.evaluate(() => new Promise(requestAnimationFrame));
    await page.unroute('**/chat');

    // A deliberate second Send of the same text remains a separate operation.
    let secondId;
    await page.route('**/chat', async route => {
        secondId = route.request().postDataJSON().request_id;
        await route.continue();
    });
    await page.locator('#message-input').fill(text);
    await page.locator('#send-btn').click();
    await page.waitForFunction(message => [...document.querySelectorAll('.message.bot')].filter(item => item.textContent === `Fixture reply: ${message}`).length === 2 && !document.querySelector('#send-btn').disabled, text);
    check(secondId !== original.request_id && /^[0-9a-f]{32}$/.test(secondId), 'A new Send reused the old ID');
    check(await page.evaluate(() => window.humanSendCount) === 2, 'Deliberate second Send did not advance exactly once');
    saved = await (await page.request.get(`${base}/sessions/session_a/history`)).json();
    check(saved.history.filter(item => item.role === 'user' && item.content === text).length === 2, 'Legitimate identical message was suppressed');
    await page.unroute('**/chat');

    // Test a genuinely non-secure HTTP origin, not localhost's secure exemption.
    const context = await page.context().browser().newContext();
    const origin = 'http://limilink-fixture.invalid';
    let insecureId, insecurePosts = 0;
    await context.route(`${origin}/**`, async route => {
        const request = route.request();
        if (request.method() === 'POST' && request.url() === `${origin}/chat`) {
            insecurePosts++;
            insecureId = request.postDataJSON().request_id;
        }
        const response = await route.fetch({ url: base + request.url().slice(origin.length) });
        await route.fulfill({ response });
    });
    const phone = await context.newPage();
    await phone.goto(origin + page.url().slice(base.length));
    await phone.waitForFunction(() => !document.querySelector('#send-btn').disabled);
    check(await phone.evaluate(() => isSecureContext) === false, 'Fixture origin accidentally has secure-context privileges');
    await phone.locator('#message-input').fill(`Plain HTTP Send ${run}`);
    await phone.locator('#send-btn').click();
    await phone.waitForFunction(() => !document.querySelector('#send-btn').disabled);
    check(/^[0-9a-f]{32}$/.test(insecureId), 'Plain HTTP could not generate an ID');
    check(insecurePosts === 1, 'Plain HTTP Send was duplicated');
    await phone.evaluate(() => Object.defineProperty(crypto, 'getRandomValues', { configurable: true, value: () => { throw new Error('fixture random source unavailable'); } }));
    await phone.locator('#message-input').fill('Keep this draft when ID generation fails');
    await phone.locator('#send-btn').click();
    check(await phone.locator('#message-input').inputValue() === 'Keep this draft when ID generation fails', 'ID generation failure lost the draft');
    check(insecurePosts === 1, 'ID generation failure silently sent without an ID');
    check((await phone.locator('#notice').textContent()).includes('could not safely identify'), 'ID generation failure was hidden');
    await context.close();
    console.log('PASS: one Send + resume produces one browser POST; concurrent/completed packet replay creates one saved user/reply; identical intentional Send gets a new ID; insecure HTTP and random-source failure are safe. No providers.');
}

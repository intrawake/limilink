// Focus-only layout regression: mocked snapshots, no chat POSTs, fake delays, or providers.
async page => {
    if (!page.url().startsWith('http://127.0.0.1:11012/')) throw new Error('Use the isolated fixture.');
    const check = (value, message) => { if (!value) throw new Error(message); };
    const history = Array.from({ length: 45 }, (_, i) => ({ role: 'bot', content: `Message ${i}\nReading line one\nReading line two\nReading line three` }));
    let busy = false, hold = false, held, seen, chatPosts = 0;
    const countPosts = request => { if (request.method() === 'POST' && request.url().endsWith('/chat')) chatPosts++; };
    page.on('request', countPosts);
    const state = () => ({ session_id: 'session_a', revision: 'scroll-stable', history, busy, busy_sessions: busy ? ['session_a'] : [] });
    await page.route('**/sessions/session_a/snapshot*', route => {
        if (hold) { held = route; seen(); }
        else route.fulfill({ json: state() });
    });
    await page.reload();
    await page.waitForFunction(() => !document.querySelector('#new-session-btn').disabled);
    await page.locator('.session-row[data-session-id="session_a"] .session-link').click();
    await page.waitForFunction(() => activeSnapshot === null);
    await page.locator('#message-input').fill('Draft stays put');
    await page.locator('#activity-toggle').focus();
    const measure = () => page.evaluate(() => {
        const chat = document.querySelector('#chat-container');
        return { height: chat.clientHeight, scrollTop: chat.scrollTop, anchorTop: window.scrollAnchor.getBoundingClientRect().top,
            sameNode: window.scrollAnchor.isConnected, focus: document.activeElement.id,
            checkingVisible: !document.querySelector('#connection-status').hidden };
    });
    const measurements = [];
    for (const thinking of [false, true]) {
        busy = thinking;
        await page.evaluate(() => syncSnapshot({ force: true }));
        for (const bottom of [false, true]) {
            await page.evaluate(atBottom => {
                const chat = document.querySelector('#chat-container');
                chat.scrollTop = atBottom ? chat.scrollHeight : 430;
                window.scrollAnchor = [...chat.children].find(node => node.getBoundingClientRect().bottom > chat.getBoundingClientRect().top + 1);
            }, bottom);
            await page.evaluate(() => new Promise(requestAnimationFrame));
            const before = await measure();
            const captured = new Promise(resolve => { seen = resolve; });
            hold = true;
            await page.evaluate(() => { window.dispatchEvent(new Event('focus')); });
            await captured;
            await page.evaluate(() => new Promise(requestAnimationFrame));
            const during = await measure();
            check(await page.locator('#send-btn').isDisabled(), 'Foreground revalidation allowed a send before fresh state');
            await held.fulfill({ json: state() });
            hold = false;
            await page.waitForFunction(() => activeSnapshot === null);
            const after = await measure();
            measurements.push({ busy: thinking, bottom, before, during, after });
        }
    }
    // A real tab round-trip must preserve the same DOM and reading position too.
    const beforeTab = await measure();
    const other = await page.context().newPage();
    await other.goto('about:blank');
    await other.bringToFront();
    await page.bringToFront();
    await page.waitForFunction(() => activeSnapshot === null);
    const afterTab = await measure();
    await other.close();
    await page.unroute('**/sessions/session_a/snapshot*');
    const stable = (a, b) => a.sameNode && b.sameNode && Math.abs(a.height - b.height) <= 1
        && Math.abs(a.scrollTop - b.scrollTop) <= 1 && Math.abs(a.anchorTop - b.anchorTop) <= 1 && a.focus === b.focus;
    const passed = measurements.every(item => stable(item.before, item.during) && stable(item.before, item.after)) && stable(beforeTab, afterTab);
    check(await page.locator('#message-input').inputValue() === 'Draft stays put', 'Focus sync changed draft');
    page.off('request', countPosts);
    check(chatPosts === 0, 'Focus checking unexpectedly posted a message');
    return { passed, measurements, tabRoundTrip: { before: beforeTab, after: afterTab }, providers: 0, chatPosts };
}

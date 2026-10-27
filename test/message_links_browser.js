// Disposable --fake-chat fixture only; all message/Send responses below are intercepted.
async page => {
    const base = 'http://127.0.0.1:11012';
    if (!page.url().startsWith(base + '/')) throw Error('Use the isolated fixture.');
    const check = (value, message) => { if (!value) throw Error(message); };
    const variant = await page.evaluate(() => new URL(location.href).searchParams.get('controller') || 'follow');
    if (variant === 'steady') {
        const script = await (await page.request.get(base + '/steady.js')).text();
        const css = await (await page.request.get(base + '/drawer.css')).text();
        await page.route('**/follow.js', route => route.fulfill({ body: script, contentType: 'text/javascript' }));
        await page.route('**/arrange.css', route => route.fulfill({ body: css, contentType: 'text/css' }));
        const html = (await (await page.request.get(page.url())).text())
            .replace('    <script src="/history-view.js?v=3" defer></script>\n', '<script>globalThis.LimilinkHistory={version:2,create(){throw Error("Stale helper used");}}</script>\n')
            .replace('    <script src="/reply-state.js?v=1" defer></script>\n', '')
            .replace('</body>', '<button id="rename-current" hidden>Rename</button></body>');
        await page.route('**/?controller=steady', route => route.fulfill({ body: html, contentType: 'text/html' }));
    }
    const bot = content => ({ role: 'bot', content });
    const history = Array.from({ length: 60 }, (_, i) => bot(i ? 'Padding ' + i : '[Older](/older)'));
    history.push(...[
        '[Labelled](https://example.invalid/path?one=1&two=2#fragment)',
        '<http://example.invalid/plain> <https://example.invalid/secure>',
        '[Relative](/example)',
        '[<img src=x onerror="globalThis.__linkXss=1">](https://example.invalid/safe)',
        '`[inline](/inline)`\n```text\n[fenced](/fenced)\n<https://example.invalid/fenced>\n```\n```unfinished\n[unfinished](/unfinished)',
        '[unsafe](javascript:alert(1)) [file](file:///etc/passwd) <img src=x onerror="globalThis.__linkXss=1"> ![image](https://example.invalid/image.png)',
        '<https://example.invalid/' + 'long'.repeat(150) + '>',
    ].map(bot));
    let revision = 0, held = null;
    const snapshot = '**/sessions/session_c/snapshot*';
    await page.route(snapshot, route => route.fulfill({ json: {
        revision: 'links-' + revision, history, busy: false, busy_sessions: [], reply: { state: 'unknown' }, send_identities: true,
    } }));
    await page.route('**/chat', route => new Promise(resolve => { held = { route, resolve }; }));
    const outsideRequests = [];
    await page.context().route('https://example.invalid/**', async route => {
        outsideRequests.push(route.request().headers());
        await route.fulfill({ contentType: 'text/html', body: '<title>Intercepted link target</title>Link target' });
    });
    try {
        await page.bringToFront();
        await page.setViewportSize({ width: 1280, height: 900 });
        await page.evaluate(() => { localStorage.clear(); sessionStorage.clear(); localStorage.setItem('limilink_last_session', 'session_c'); });
        await page.reload();
        await page.waitForFunction(() => historyReady && currentSession === 'session_c' && !sendButton.disabled);
        await page.evaluate(() => { globalThis.__linkXss = 0; });
        check(await page.evaluate(() => globalThis.LimilinkHistory.version) === 3, 'Cached helper was not upgraded');
        const chat = page.locator('#chat-container');
        const labelled = chat.getByRole('link', { name: 'Labelled', exact: true });
        check(await chat.locator('a').count() === 6, 'Wrong initial link count');
        check(await labelled.getAttribute('href') === 'https://example.invalid/path?one=1&two=2#fragment', 'Labelled URL changed');
        check(await chat.getByRole('link', { name: 'Relative', exact: true }).getAttribute('href') === base + '/example', 'Relative URL not resolved against page');
        check(await chat.getByRole('link', { name: 'http://example.invalid/plain', exact: true }).count() === 1, 'HTTP autolink missing');
        check(await chat.getByRole('link', { name: 'https://example.invalid/secure', exact: true }).count() === 1, 'HTTPS autolink missing');
        check(await chat.locator('img,script,iframe').count() === 0 && await page.evaluate(() => globalThis.__linkXss) === 0, 'Message HTML was interpreted');
        check(await chat.locator('pre code').count() === 1 && await chat.locator('pre a').count() === 0, 'Fenced code changed');
        check(await chat.locator('pre code').textContent() === 'text\n[fenced](/fenced)\n<https://example.invalid/fenced>\n', 'Code bytes changed');
        const safe = await chat.locator('a').evaluateAll(nodes => nodes.every(node => ['http:', 'https:'].includes(new URL(node.href).protocol)
            && node.target === '_blank' && node.relList.contains('noopener') && node.relList.contains('noreferrer')));
        check(safe, 'Unsafe scheme or new-tab attributes');
        await labelled.evaluate(node => { node.closest('.message').dataset.kept = 'yes'; });

        for (const width of [1280, 375, 320]) {
            await page.setViewportSize({ width, height: 900 });
            await chat.locator('a').last().scrollIntoViewIfNeeded();
            check(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'Long link overflows at ' + width);
            check(await chat.evaluate(node => node.scrollWidth <= node.clientWidth + 1), 'Chat overflows at ' + width);
        }
        await page.setViewportSize({ width: 1280, height: 900 });
        const input = page.locator('#message-input');
        await input.fill('Unsent draft');
        await labelled.focus();
        await page.keyboard.press('Tab');
        await page.keyboard.press('Shift+Tab');
        check(await labelled.evaluate(node => document.activeElement === node && getComputedStyle(node).textDecorationLine.includes('underline') && getComputedStyle(node).outlineStyle !== 'none'), 'Link lacks visible keyboard focus');
        const popupWait = page.waitForEvent('popup');
        await labelled.press('Enter');
        const popup = await popupWait;
        try {
            await popup.waitForLoadState('domcontentloaded');
            check(await popup.evaluate(() => window.opener === null && document.referrer === ''), 'Link exposes opener/referrer');
        } finally { await popup.close(); }
        await page.bringToFront();
        check(outsideRequests.length === 1 && !outsideRequests[0].referer, 'Unexpected external requests or referrer');
        check(await input.inputValue() === 'Unsent draft' && await page.evaluate(() => currentSession) === 'session_c', 'Link navigation lost draft/conversation');

        await chat.evaluate(node => { node.scrollTop = 0; });
        await page.locator('.load-older').click();
        check(await chat.getByRole('link', { name: 'Older', exact: true }).count() === 1, 'Prepended history not linkified');
        const sent = '[Optimistic](/optimistic) <https://example.invalid/pending>';
        await input.fill(sent);
        await page.locator('#send-btn').click();
        await page.waitForFunction(() => pendingSends.size === 1);
        const optimistic = chat.getByRole('link', { name: 'Optimistic', exact: true });
        await optimistic.evaluate(node => { node.dataset.optimistic = 'kept'; });
        await page.evaluate(() => syncSnapshot({ force: true }));
        check(await chat.locator('a[data-optimistic="kept"]').count() === 1, 'Unchanged snapshot removed optimistic link');
        check(await chat.getByRole('link', { name: 'https://example.invalid/pending', exact: true }).count() === 1, 'Optimistic autolink absent');
        check(held, 'Synthetic Send was not intercepted');
        history.push({ role: 'user', content: sent, request_id: held.route.request().postDataJSON().request_id }, bot('Reply [Appended](/appended)'));
        revision++;
        await page.evaluate(() => syncSnapshot({ force: true }));
        check(await chat.getByRole('link', { name: 'Appended', exact: true }).count() === 1, 'Appended reply not linkified');
        check(await chat.getByRole('link', { name: 'Optimistic', exact: true }).count() === 1, 'Canonical update duplicated optimistic link');
        check(await chat.locator('.message[data-kept="yes"]').count() === 1, 'Linkification rebuilt old canonical nodes');
        check(held, 'Synthetic Send was not intercepted');
        await held.route.fulfill({ json: { reply: 'Reply [Appended](/appended)' } }); held.resolve(); held = null;
        await page.waitForFunction(() => pendingSends.size === 0 && activePosts.size === 0 && activeSnapshot === null);
        return { controller: variant, labelled: true, autolinks: ['http', 'https'], relative: true,
            literal: ['code', 'unfinished fence', 'HTML', 'images', 'unsafe schemes'],
            stages: ['history', 'older', 'optimistic', 'canonical append'], widths: [1280, 375, 320],
            navigation: 'keyboard/new tab/no opener or referrer/draft retained', network: 'fixture and intercepted target only' };
    } finally {
        if (held) { await held.route.fulfill({ status: 500, json: { detail: 'Fixture cleanup' } }); held.resolve(); }
        await page.unroute('**/chat');
        await page.unroute(snapshot);
        await page.context().unroute('https://example.invalid/**');
    }
}

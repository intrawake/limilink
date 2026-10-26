// Owned fake-chat fixture only. Presentation checks make no mutating requests.
async page => {
    const base = 'http://127.0.0.1:11012';
    if (!page.url().startsWith(base + '/')) throw Error('Use the isolated fixture.');
    const check = (value, message) => { if (!value) throw Error(message); };
    const variant = await page.evaluate(() => new URL(location.href).searchParams.get('controller') || 'follow');
    const originalViewport = page.viewportSize();
    if (variant === 'steady') {
        const script = await (await page.request.get(base + '/steady.js')).text();
        const css = await (await page.request.get(base + '/drawer.css')).text();
        await page.route('**/follow.js', route => route.fulfill({ body: script, contentType: 'text/javascript' }));
        await page.route('**/arrange.css', route => route.fulfill({ body: css, contentType: 'text/css' }));
        const html = (await (await page.request.get(page.url())).text())
            .replace('</body>', '<button id="rename-current" hidden>Rename</button></body>');
        await page.route('**/?controller=steady', route => route.fulfill({ body: html, contentType: 'text/html' }));
    }
    const writes = [];
    const onRequest = request => { if (!['GET', 'HEAD'].includes(request.method())) writes.push(request.method()); };
    page.on('request', onRequest);
    try {
        await page.bringToFront();
        await page.emulateMedia({ reducedMotion: 'no-preference' });
        await page.evaluate(() => {
            localStorage.clear(); sessionStorage.clear();
            localStorage.setItem('limilink_last_session', 'session_b');
        });
        await page.reload();
        await page.waitForFunction(() => historyReady && replies && sessions.some(item => item.id === 'session_a'));
        await page.evaluate(() => {
            pauseUpdates();
            serverBusy.clear(); pendingSends.clear(); unconfirmedSends.clear();
            sessions.find(item => item.id === 'session_a').title = 'A very long conversation title that still leaves every status and the options menu usable';
            addPending('session_a', { id: 'f'.repeat(32), text: 'Not admitted' });
            renderSessions();
        });
        const row = page.locator('.session-row[data-session-id="session_a"]');
        check(await row.locator('.session-working').count() === 0, 'Local pending Send incorrectly means Working');
        check(await row.locator('.session-delivery').textContent() === 'Sending…', 'Delivery status lost');
        await page.evaluate(() => {
            pendingSends.clear(); serverBusy.add('session_a');
            unconfirmedSends.set('session_a', [{ id: 'e'.repeat(32), text: 'Unconfirmed fixture', failed: false }]);
            replies.observe('session_a', { state: 'known', token: 'r1:' + '0'.repeat(64), index: 0 });
            replies.observe('session_a', { state: 'known', token: 'r1:' + '1'.repeat(64), index: 1 });
            renderSessions();
        });
        for (const width of [1280, 375, 320]) {
            await page.setViewportSize({ width, height: 900 });
            await page.waitForFunction(width => mobile.matches === (width <= 720), width);
            // Let the responsive change event finish closing the old drawer first.
            await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
            await page.evaluate(() => setDrawer(false, false));
            if (width <= 720) await page.locator('#sidebar-toggle').click();
            const working = row.locator('.session-working');
            await working.waitFor({ state: 'visible' });
            check(await working.textContent() === '⏳', 'Static hourglass changed at ' + width);
            check(await working.getAttribute('title') === 'Working', 'Working tooltip lost');
            check(await working.getAttribute('aria-label') === 'Working', 'Working accessible name lost');
            check(await row.locator('.session-unread').isVisible(), 'Working hid unread reply');
            check(await row.locator('.session-delivery').textContent() === 'Unconfirmed', 'Working hid delivery uncertainty');
            check(await row.locator('summary').textContent() === '⋯', 'Options menu changed');
            const geometry = await row.evaluate(node => {
                const link = node.querySelector('.session-link').getBoundingClientRect();
                const menu = node.querySelector('summary').getBoundingClientRect();
                return [...node.querySelectorAll('.session-status > span')].every(badge => {
                    const box = badge.getBoundingClientRect();
                    return box.width > 0 && box.left >= link.left && box.right <= link.right + 1
                        && box.right <= menu.left + 1 && badge.scrollWidth <= badge.clientWidth + 1;
                });
            });
            check(geometry, 'Status clipped or overlapped menu at ' + width);
        }
        const working = row.locator('.session-working');
        for (const preference of ['no-preference', 'reduce']) {
            await page.emulateMedia({ reducedMotion: preference });
            check(await working.evaluate(node => node.getAnimations({ subtree: true }).length === 0
                && getComputedStyle(node).animationName === 'none'
                && getComputedStyle(node, '::before').content === 'none'), 'Working indicator still moves');
            check(await working.isVisible() && await working.textContent() === '⏳', 'Motion preference changed the indicator');
        }
        await row.locator('summary').click();
        check(await row.getByRole('button', { name: 'Rename', exact: true }).isVisible(), 'Options menu no longer opens');
        await row.locator('summary').click();
        await page.evaluate(() => { serverBusy.clear(); renderSessions(); });
        check(await row.locator('.session-working').count() === 0, 'Idle session retained working indicator');
        check(await row.locator('.session-unread').isVisible() && await row.locator('.session-delivery').textContent() === 'Unconfirmed', 'Idle cleared unrelated facts');
        check(writes.length === 0, 'Presentation check made a mutating request');
        return { controller: variant, widths: [1280, 375, 320], working: 'static hourglass with Working tooltip/name', motion: 'none under either preference',
            separate: ['server work', 'delivery uncertainty', 'unread'], menu: 'unchanged and usable', requests: 'GET/HEAD only' };
    } finally {
        page.off('request', onRequest);
        await page.emulateMedia({ reducedMotion: null });
        if (originalViewport) await page.setViewportSize(originalViewport);
        if (variant === 'steady') {
            await page.unroute('**/follow.js');
            await page.unroute('**/arrange.css');
            await page.unroute('**/?controller=steady');
        }
        await page.reload();
    }
}

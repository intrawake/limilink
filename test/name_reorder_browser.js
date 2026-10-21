// Disposable --fake-chat fixture. Native mouse/touch holds; no provider calls.
async page => {
    const base = 'http://127.0.0.1:11012';
    if (!page.url().startsWith(base + '/')) throw new Error('Use the isolated fixture.');
    const entry = page.url();
    const check = (value, message) => { if (!value) throw new Error(message); };
    const row = (p, id) => p.locator(`.session-row[data-session-id="${id}"]`);
    const link = (p, id) => row(p, id).locator('.session-link');
    const ready = p => p.waitForFunction(() => !document.querySelector('#new-session-btn').disabled);
    const current = p => p.locator('#session-directory').textContent();
    const order = p => p.locator('.session-row').evaluateAll(rows => rows.map(item => item.dataset.sessionId).join(','));
    const flush = p => p.evaluate(() => new Promise(requestAnimationFrame));
    const position = async element => { const b = await element.boundingBox(); return { x: b.x + b.width / 2, y: b.y + b.height / 2 }; };
    check((await page.request.put(`${base}/session-sidebar/order`, { data: { session_ids: ['session_a', 'session_b', 'session_c'] } })).ok(), 'Fixture initial order reset failed');
    let writes = 0;
    const count = request => { if (request.method() === 'PUT' && request.url().includes('/session-sidebar/order')) writes++; };
    page.on('request', count);
    await page.reload();
    await ready(page);
    check(await page.evaluate(() => document.activeElement.id !== 'message-input'), 'Startup stole composer focus');
    await link(page, 'session_b').click();
    check(await page.locator('#message-input').evaluate(element => document.activeElement === element), 'Desktop switch did not focus composer');
    await page.locator('#message-input').fill('B draft');
    await link(page, 'session_c').focus();
    await page.keyboard.press('Enter');
    check(await page.locator('#message-input').evaluate(element => document.activeElement === element), 'Desktop keyboard switch did not focus composer');
    await link(page, 'session_b').click();
    check(await page.locator('#message-input').inputValue() === 'B draft', 'Switch focus damaged draft');

    // A late history response may not acquire focus after newer navigation/control intent.
    let held, seen;
    const captured = new Promise(resolve => { seen = resolve; });
    await page.route('**/sessions/session_a/snapshot*', route => { held = route; seen(); });
    await link(page, 'session_a').click();
    await captured;
    await link(page, 'session_b').click();
    await page.locator('#activity-toggle').focus();
    await held.fulfill({ json: { revision: 'late-a', busy: false, busy_sessions: [], history: [] } });
    await flush(page);
    check(await current(page) === 'session_b', 'Late history changed selected session');
    check(await page.evaluate(() => document.activeElement.id === 'activity-toggle'), 'Late history stole focus');
    await page.unroute('**/sessions/session_a/snapshot*');

    const mouseHold = async id => {
        const point = await position(link(page, id));
        await page.mouse.move(point.x, point.y);
        await page.mouse.down();
        await row(page, id).locator('.session-link').waitFor();
        await page.waitForFunction(key => document.querySelector(`.session-row[data-session-id="${key}"]`).classList.contains('name-reordering'), id);
    };
    const mouseDrop = async (id, target) => {
        await mouseHold(id);
        const b = await row(page, target).boundingBox();
        await page.mouse.move(b.x + 100, b.y + 2, { steps: 4 });
        await page.mouse.up();
        await ready(page);
    };
    await mouseDrop('session_c', 'session_a');
    check(await order(page) === 'session_c,session_a,session_b', 'Name-hold mouse reorder failed');
    check(await current(page) === 'session_b', 'Drag release switched sessions');
    check(writes === 1, 'One mouse drop did not produce exactly one order write');
    check(await link(page, 'session_a').evaluate(element => element.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }))), 'Ordinary context menu was globally blocked');
    await mouseHold('session_a');
    check(!(await link(page, 'session_a').evaluate(element => element.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true })))), 'Hold context menu was not suppressed');
    await page.mouse.up();
    await flush(page);
    check(await current(page) === 'session_b' && writes === 1, 'Stationary hold clicked or saved');
    await link(page, 'session_a').click();
    check(await current(page) === 'session_a', 'Release guard swallowed next deliberate click');
    await mouseHold('session_c');
    await page.keyboard.press('Escape');
    await page.mouse.up();
    check(writes === 1 && await current(page) === 'session_a', 'Escape failed to cancel reorder');
    await mouseHold('session_c');
    await page.mouse.move(700, 400);
    await page.mouse.up();
    check(writes === 1, 'Release outside list committed order');
    await mouseHold('session_c');
    await page.evaluate(() => renderSessions());
    await page.mouse.up();
    check(writes === 1 && await current(page) === 'session_a', 'Rerender committed or clicked stale gesture');
    await mouseHold('session_c');
    await page.evaluate(() => window.dispatchEvent(new Event('blur')));
    await page.mouse.up();
    check(writes === 1, 'Blur did not cancel');
    await mouseHold('session_c');
    await page.evaluate(() => {
        Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
        document.dispatchEvent(new Event('visibilitychange'));
    });
    await page.mouse.up();
    check(writes === 1 && await page.locator('.name-reordering').count() === 0, 'Hiding did not cancel');
    await page.evaluate(() => {
        Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' });
        document.dispatchEvent(new Event('visibilitychange'));
    });
    await mouseHold('session_c');
    check((await page.request.post(`${base}/sessions/session_c/trash`)).ok(), 'Fixture trash failed');
    await page.evaluate(data => applySessions(data), await (await page.request.get(`${base}/session-sidebar`)).json());
    await page.mouse.up();
    check(writes === 1 && await page.locator('.name-reordering').count() === 0, 'Trash/rerender committed stale gesture');
    await link(page, 'session_c').click();
    check(await page.locator('#message-input').isDisabled() && await page.evaluate(() => document.activeElement.id !== 'message-input'), 'Trashed selection focused disabled composer');
    check((await page.request.delete(`${base}/sessions/session_c/trash`)).ok(), 'Fixture restore failed');
    check((await page.request.put(`${base}/session-sidebar/order`, { data: { session_ids: ['session_c', 'session_a', 'session_b'] } })).ok(), 'Fixture order restore failed');
    await page.evaluate(data => applySessions(data), await (await page.request.get(`${base}/session-sidebar`)).json());
    await link(page, 'session_a').click();

    await page.route('**/session-sidebar/order', route => route.fulfill({ status: 500, json: { detail: 'Hold reorder failure' } }));
    await mouseDrop('session_b', 'session_c');
    check(await order(page) === 'session_c,session_a,session_b', 'Failed order did not roll back to server state');
    check((await page.locator('#notice').textContent()).includes('Hold reorder failure'), 'Order failure was hidden');
    await page.unroute('**/session-sidebar/order');
    await page.reload();
    await ready(page);
    check(await order(page) === 'session_c,session_a,session_b', 'Successful order was not persistent');
    page.off('request', count);

    const browser = page.context().browser();
    // isMobile emulates layout/input, not device identity. Keep this a phone
    // after widening it below, rather than accidentally simulating a touch laptop.
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, userAgent: 'Mozilla/5.0 (iPhone) TestBrowser' });
    const phone = await context.newPage();
    phone.setDefaultTimeout(5000);
    let touchStage = 'mobile startup and selection';
    let touchWrites = 0;
    phone.on('request', request => { if (request.method() === 'PUT' && request.url().includes('/session-sidebar/order')) touchWrites++; });
    const cdp = await context.newCDPSession(phone);
    const touch = (type, points = []) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: points });
    const point = (x, y, id = 1) => ({ x, y, id });
    try {
        await phone.goto(entry);
        await ready(phone);
        check(await phone.evaluate(() => document.activeElement.tagName !== 'TEXTAREA'), 'Mobile startup focused composer');
        await phone.locator('#sidebar-toggle').tap();
        await link(phone, 'session_b').tap();
        check(await phone.evaluate(() => document.activeElement.tagName !== 'TEXTAREA'), 'Mobile session selection summoned keyboard');
        await phone.locator('#message-input').fill('Mobile draft');
        await phone.locator('#sidebar-toggle').tap();
        touchStage = 'native touch name drop';
        const a = await row(phone, 'session_a').boundingBox();
        const b = await position(link(phone, 'session_b'));
        await touch('touchStart', [point(b.x, b.y)]);
        await phone.waitForFunction(() => document.querySelector('.session-row[data-session-id="session_b"]').classList.contains('name-reordering'));
        await touch('touchMove', [point(b.x, a.y + 2)]);
        await touch('touchEnd');
        await ready(phone);
        check(await order(phone) === 'session_c,session_b,session_a', 'Native touch name-hold reorder failed');
        check(await current(phone) === 'session_b' && touchWrites === 1, 'Touch drag clicked or saved twice');
        check(await phone.locator('#message-input').inputValue() === 'Mobile draft', 'Touch drag changed composer draft');
        check(await phone.evaluate(() => document.activeElement.tagName !== 'TEXTAREA'), 'Touch drop focused keyboard');

        touchStage = 'stationary native touch hold';
        let p = await position(link(phone, 'session_a'));
        await touch('touchStart', [point(p.x, p.y)]);
        await phone.waitForFunction(() => document.querySelector('.session-row[data-session-id="session_a"]').classList.contains('name-reordering'));
        await touch('touchEnd');
        await flush(phone);
        check(await current(phone) === 'session_b' && touchWrites === 1, 'Stationary touch hold produced a click');
        await link(phone, 'session_a').tap();
        check(await current(phone) === 'session_a', 'Next intentional tap was swallowed');
        await phone.locator('#sidebar-toggle').tap();
        touchStage = 'native touch cancellation';
        p = await position(link(phone, 'session_b'));
        await touch('touchStart', [point(p.x, p.y)]);
        await phone.waitForFunction(() => document.querySelector('.name-reordering'));
        await touch('touchCancel');
        check(touchWrites === 1 && await phone.locator('.name-reordering').count() === 0, 'Touch cancellation failed');
        await touch('touchStart', [point(p.x, p.y)]);
        await phone.waitForFunction(() => document.querySelector('.name-reordering'));
        await touch('touchStart', [point(p.x, p.y), point(p.x + 30, p.y + 20, 2)]);
        await touch('touchEnd');
        check(touchWrites === 1 && await phone.locator('.name-reordering').count() === 0, 'Multi-touch did not cancel');

        touchStage = 'pre-hold native scrolling';
        // Before the hold, ordinary vertical scrolling must remain native.
        const canonical = await (await phone.request.get(`${base}/session-sidebar`)).json();
        await phone.evaluate(data => applySessions({ ...data, sessions: [...data.sessions, ...Array.from({ length: 30 }, (_, i) => ({ id: `overflow_${i}`, title: `Overflow ${i}` }))] }), canonical);
        const list = await phone.locator('#session-list').boundingBox();
        // Exercise the active hold before the native fling; an in-flight fling
        // is explicitly allowed to cancel a not-yet-activated hold.
        touchStage = 'edge autoscroll hold';
        const first = await position(link(phone, 'session_c'));
        await touch('touchStart', [point(first.x, first.y)]);
        await phone.waitForFunction(() => document.querySelector('.name-reordering'));
        await touch('touchMove', [point(first.x, list.y + list.height - 5)]);
        await phone.waitForFunction(() => document.querySelector('#session-list').scrollTop > 50);
        await touch('touchCancel');
        check(touchWrites === 1, 'Cancelled edge autoscroll committed synthetic rows');
        await phone.locator('#session-list').evaluate(element => element.scrollTop = 0);
        touchStage = 'pre-hold native scrolling';
        await touch('touchStart', [point(list.x + 100, list.y + 350)]);
        for (const delta of [30, 70, 130, 200]) await touch('touchMove', [point(list.x + 100, list.y + 350 - delta)]);
        await touch('touchEnd');
        await phone.waitForFunction(() => document.querySelector('#session-list').scrollTop > 40);
        check(touchWrites === 1 && await phone.locator('.name-reordering').count() === 0, 'Native scroll armed or saved reorder');
        await phone.evaluate(data => applySessions(data), canonical);
        await phone.locator('#sidebar-close').tap();
        await phone.setViewportSize({ width: 1024, height: 844 });
        await link(phone, 'session_b').tap();
        check(await phone.evaluate(() => !matchMedia('(max-width:720px)').matches && !matchMedia('(hover:hover) and (pointer:fine)').matches), 'Wide touch fixture is not coarse');
        check(await phone.evaluate(() => document.activeElement.tagName !== 'TEXTAREA'), 'Wide touch layout summoned keyboard');
    } catch (error) { throw new Error(`${touchStage}: ${error.message}`); }
    finally { await cdp.detach(); await context.close(); }
    return { passed: true, desktopFocus: true, touchKeyboardAvoided: true, mouseAndNativeTouchHold: true, cancellationAndRollback: true, nativeScroll: true, providers: 0 };
}

// Run with playwright-cli run-code --filename test/sidebar_browser.js against
// an isolated server on 127.0.0.1:11012 seeded with session_a/b/c. No model calls.
async page => {
    if (!page.url().startsWith('http://127.0.0.1:11012/')) throw new Error('Use the isolated fixture server, never production.');
    const check = (condition, message) => { if (!condition) throw new Error(message); };
    const snapshot = (history, revision) => ({ session_id: 'session_a', history, revision, busy: false, busy_sessions: [] });
    const row = id => page.locator(`.session-row[data-session-id="${id}"]`);
    const rename = async id => {
        if (!(await row(id).locator('details').evaluate(element => element.open))) await row(id).locator('summary').click();
        await row(id).getByRole('button', { name: 'Rename', exact: true }).click();
    };
    const select = async id => {
        await row(id).locator('.session-link').click();
        await page.waitForFunction(() => document.querySelector('#chat-container').getAttribute('aria-busy') === 'false');
    };
    const ids = () => page.locator('.session-row').evaluateAll(rows => rows.map(row => row.dataset.sessionId));
    const settled = () => page.waitForFunction(() => !document.querySelector('#new-session-btn').disabled);
    const flush = () => page.evaluate(() => new Promise(requestAnimationFrame));
    await page.reload();
    await page.waitForSelector('.session-row');
    await settled();
    await select('session_a');
    await page.locator('#message-input').fill('Unsent Alpha draft');
    await select('session_b');
    check(await page.locator('#message-input').inputValue() === '', 'Draft leaked from A into B');
    await page.locator('#message-input').fill('Unsent Beta draft');
    await select('session_a');
    check(await page.locator('#message-input').inputValue() === 'Unsent Alpha draft', 'Alpha draft was lost');
    check(await page.locator('#rename-current').count() === 0, 'Rename still appears in chat header');
    await rename('session_a');
    await page.locator('#session-title-input').fill('Interface planning');
    await page.getByRole('button', { name: 'Save title', exact: true }).click();
    await page.waitForFunction(() => !document.querySelector('#rename-dialog').open);
    check(await page.locator('#session-title').textContent() === 'Interface planning', 'Rename not reflected in heading');
    check(await page.locator('#session-directory').textContent() === 'session_a', 'Rename changed session identity');
    await row('session_c').locator('summary').click();
    await row('session_c').getByRole('button', { name: 'Move up', exact: true }).click();
    await settled();
    check((await ids()).join() === 'session_a,session_c,session_b', 'Move-up failed');
    await row('session_b').locator('.drag-handle').dragTo(row('session_a'), { targetPosition: { x: 100, y: 5 } });
    await settled();
    check((await ids()).join() === 'session_b,session_a,session_c', 'Native drag reorder failed');
    await row('session_a').locator('.drag-handle').dragTo(row('session_c'), { targetPosition: { x: 100, y: 48 } });
    await settled();
    check((await ids()).join() === 'session_b,session_c,session_a', 'Cannot drag a session to the end');
    await row('session_a').locator('summary').click();
    await row('session_a').getByRole('button', { name: 'Move up', exact: true }).click();
    await settled();
    await page.reload();
    await page.waitForFunction(() => document.querySelector('#chat-container').getAttribute('aria-busy') === 'false');
    check((await ids()).join() === 'session_b,session_a,session_c', 'Order did not survive reload');
    check(await page.locator('#session-title').textContent() === 'Interface planning', 'Title/selection did not survive reload');
    check(await page.getByRole('searchbox').count() === 0, 'Unneeded session search is still present');

    // Failed saves stay visibly failed and do not show a false new title/order.
    await page.route('**/sessions/session_a/title', route => route.fulfill({ status: 500, json: { detail: 'Test disk error' } }));
    await rename('session_a');
    await page.locator('#session-title-input').fill('Must not appear');
    await page.getByRole('button', { name: 'Save title', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('#rename-error').textContent.includes('Test disk error'));
    check(await page.locator('#rename-dialog').evaluate(element => element.open), 'Failed rename closed its dialog');
    check(await page.locator('#session-title').textContent() === 'Interface planning', 'Failed rename changed heading');
    await page.locator('#rename-cancel').click();
    await page.unroute('**/sessions/session_a/title');
    await page.route('**/session-sidebar/order', route => route.fulfill({ status: 500, json: { detail: 'Test order failure' } }));
    await row('session_c').locator('summary').click();
    await row('session_c').getByRole('button', { name: 'Move up', exact: true }).click();
    await settled();
    check((await ids()).join() === 'session_b,session_a,session_c', 'Failed reorder changed visible order');
    check((await page.locator('#notice').textContent()).includes('Test order failure'), 'Reorder failure was hidden');
    await page.unroute('**/session-sidebar/order');

    // A -> B -> A: deliver the newer A history first, then an obsolete A history.
    await select('session_b');
    const pending = [];
    let firstSeen, secondSeen;
    const first = new Promise(resolve => { firstSeen = resolve; });
    const second = new Promise(resolve => { secondSeen = resolve; });
    await page.route('**/sessions/session_a/snapshot*', route => {
        pending.push(route);
        if (pending.length === 1) firstSeen(); else secondSeen();
    });
    await row('session_a').locator('.session-link').click();
    await first;
    check(await page.locator('#send-btn').isDisabled(), 'Send enabled before history resolved');
    await select('session_b');
    await row('session_a').locator('.session-link').click();
    await second;
    await pending[1].fulfill({ json: snapshot([{ role: 'bot', content: 'Fresh A view' }], 'fresh-a') });
    await page.waitForFunction(() => document.querySelector('#chat-container').textContent.includes('Fresh A view'));
    await pending[0].fulfill({ json: snapshot([{ role: 'bot', content: 'Stale A view' }], 'stale-a') });
    await flush();
    check(!(await page.locator('#chat-container').textContent()).includes('Stale A view'), 'Old A response overwrote the newer A view');
    await page.unroute('**/sessions/session_a/snapshot*');

    // Complete a chat after history already contains its reply; never duplicate it.
    let chatRoute, sent;
    const chatSeen = new Promise(resolve => { sent = resolve; });
    await page.route('**/chat', route => { chatRoute = route; sent(); });
    await page.locator('#message-input').fill('Hello Alpha');
    await page.locator('#message-input').press('Enter');
    await chatSeen;
    check(await page.locator('#send-btn').isDisabled(), 'Pending send was not disabled');
    await row('session_a').locator('summary').click();
    check(await row('session_a').locator('.trash-button').isEnabled(), 'Active work should be trashable without being killed');
    const replyHistory = [
        { role: 'user', content: 'Hello Alpha' },
        { role: 'bot', content: 'Exactly one reply' },
    ];
    await page.route('**/sessions/session_a/snapshot*', route => route.fulfill({ json: snapshot(replyHistory, 'reply-history') }));
    await select('session_b');
    await select('session_a');
    const reconciled = page.waitForResponse(response => response.url().includes('/sessions/session_a/snapshot'));
    await chatRoute.fulfill({ json: { reply: 'Exactly one reply' } });
    await reconciled;
    await page.waitForFunction(() => !document.querySelector('#send-btn').disabled);
    check(await page.locator('.message.bot').count() === 1, 'Reply duplicated after history reconciliation');
    check(await page.locator('.message.user').count() === 1, 'User message duplicated after history reconciliation');
    await page.unroute('**/chat');
    await page.unroute('**/sessions/session_a/snapshot*');

    // Titles are text, never HTML.
    await rename('session_a');
    await page.locator('#session-title-input').fill('<img src=x onerror="window.titleInjection=true">');
    await page.getByRole('button', { name: 'Save title', exact: true }).click();
    await page.waitForFunction(() => !document.querySelector('#rename-dialog').open);
    check(await page.locator('#session-list img').count() === 0, 'Title was interpreted as markup');
    check(!(await page.evaluate(() => window.titleInjection)), 'Title executed script');
    await rename('session_a');
    await page.locator('#session-title-input').fill('Interface planning');
    await page.getByRole('button', { name: 'Save title', exact: true }).click();
    await page.waitForFunction(() => !document.querySelector('#rename-dialog').open);

    // One tap queues trash without a dialog, preserves it on reload, and offers Undo.
    let confirmations = 0;
    const unexpectedDialog = dialog => { confirmations++; dialog.dismiss(); };
    page.on('dialog', unexpectedDialog);
    const originalOrder = (await ids()).join();
    await row('session_a').locator('.trash-button').click();
    await settled();
    check((await ids()).at(-1) === 'session_a', 'Trash did not move the session last');
    check(await row('session_a').evaluate(element => element.classList.contains('trashed')), 'Trash title is not greyed');
    check(await row('session_a').locator('.session-name').evaluate(element => getComputedStyle(element).color) === 'rgb(144, 148, 156)', 'Trashed title color is not grey');
    check(await page.locator('#send-btn').isDisabled(), 'Can send new work to a trashed session');
    const deadline = await row('session_a').locator('.trash-countdown').getAttribute('data-delete-at');
    await page.reload();
    await settled();
    check(await row('session_a').locator('.trash-countdown').getAttribute('data-delete-at') === deadline, 'Reload reset the Undo deadline');
    await row('session_a').locator('.trash-button').click();
    await settled();
    check((await ids()).join() === originalOrder, 'Undo did not restore the saved position');
    check(!(await row('session_a').evaluate(element => element.classList.contains('trashed'))), 'Undo left the session grey');
    check(confirmations === 0, 'Trash showed a confirmation dialog');
    page.off('dialog', unexpectedDialog);
    await page.route('**/sessions/session_a/trash', route => route.fulfill({ status: 500, json: { detail: 'Test trash failure' } }));
    await row('session_a').locator('.trash-button').click();
    await settled();
    check(!(await row('session_a').evaluate(element => element.classList.contains('trashed'))), 'Failed trash falsely marked the session');
    check((await page.locator('#notice').textContent()).includes('Test trash failure'), 'Trash error was hidden');
    await page.unroute('**/sessions/session_a/trash');

    // Options for the final row must remain reachable in a long, scrolled list.
    const liveList = (await (await page.request.get('http://127.0.0.1:11012/session-sidebar')).json()).sessions;
    const overflow = Array.from({ length: 40 }, (_, index) => ({ id: `overflow_${index}`, title: `Overflow row ${index}` }));
    await page.route('**/session-sidebar', route => route.fulfill({ json: { sessions: [...liveList, ...overflow] } }));
    await page.reload();
    await settled();
    await row('overflow_39').locator('summary').click();
    await page.waitForFunction(() => {
        const menu = document.querySelector('.session-row[data-session-id="overflow_39"] .menu-items').getBoundingClientRect();
        const list = document.querySelector('#session-list').getBoundingClientRect();
        return menu.top >= list.top - 1 && menu.bottom <= list.bottom + 1;
    });
    await page.unroute('**/session-sidebar');
    await page.reload();
    await settled();

    const browser = page.context().browser();
    const phoneContext = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
    const phone = await phoneContext.newPage();
    await phone.goto(page.url());
    await phone.waitForFunction(() => !document.querySelector('#new-session-btn').disabled);
    check(await phone.locator('#session-sidebar').evaluate(element => element.inert), 'Closed phone drawer is keyboard-accessible');
    await phone.getByRole('button', { name: 'Open sessions', exact: true }).click();
    check(await phone.locator('#session-sidebar').isVisible(), 'Phone drawer failed to open');
    check(await phone.evaluate(() => document.activeElement.tagName === 'BUTTON'), 'Drawer focused a text field and would summon the mobile keyboard');
    check(await phone.getByRole('searchbox').count() === 0, 'Mobile search was not removed');
    await phone.locator('#sidebar-close').focus();
    await phone.keyboard.press('Shift+Tab');
    check(await phone.evaluate(() => document.querySelector('#session-sidebar').contains(document.activeElement)), 'Drawer focus escaped');
    await phone.keyboard.press('Escape');
    check(await phone.locator('#session-sidebar').evaluate(element => element.inert), 'Escape did not close drawer');
    await phone.getByRole('button', { name: 'Open sessions', exact: true }).click();
    await phone.locator('#sidebar-backdrop').click({ position: { x: 380, y: 700 } });
    check(await phone.locator('#session-sidebar').evaluate(element => element.inert), 'Backdrop did not close drawer');
    await phone.getByRole('button', { name: 'Open sessions', exact: true }).click();
    await phone.locator('.session-row[data-session-id="session_c"] summary').click();
    await phone.locator('.session-row[data-session-id="session_c"]').getByRole('button', { name: 'Move up', exact: true }).click();
    await phone.waitForFunction(() => !document.querySelector('#new-session-btn').disabled);
    const phoneOrder = await phone.locator('.session-row').evaluateAll(rows => rows.map(row => row.dataset.sessionId));
    check(phoneOrder.join() === 'session_b,session_c,session_a', 'Touch-accessible reorder failed');
    await phone.locator('.session-row[data-session-id="session_c"] .trash-button').click();
    await phone.waitForFunction(() => !document.querySelector('#new-session-btn').disabled);
    check(await phone.locator('.session-row').last().getAttribute('data-session-id') === 'session_c', 'Touch trash did not move the session last');
    check(await phone.evaluate(() => document.activeElement.tagName !== 'INPUT' && document.activeElement.tagName !== 'TEXTAREA'), 'Touch trash focused a text field');
    await phone.locator('.session-row[data-session-id="session_c"] .trash-button').click();
    await phone.waitForFunction(() => !document.querySelector('#new-session-btn').disabled);
    await phone.locator('.session-row[data-session-id="session_a"] .session-link').click();
    check(await phone.locator('#session-sidebar').evaluate(element => element.inert), 'Session selection did not close phone drawer');
    await phone.locator('#message-input').fill('Mobile newline');
    let mobileCalls = 0;
    await phone.route('**/chat', route => { mobileCalls++; route.abort(); });
    await phone.locator('#message-input').press('Enter');
    check((await phone.locator('#message-input').inputValue()).includes('\n'), 'Mobile Enter did not insert a newline');
    check(mobileCalls === 0, 'Mobile Enter unexpectedly sent a message');
    check(await phone.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'Phone layout overflows horizontally');
    await phoneContext.close();
    console.log('PASS: rename/order persistence, drag, drafts, visible failures, A-B-A history race, send reconciliation, title safety, no-confirmation trash/Undo, mobile drawer without input focus, touch reorder/trash/newline. No model calls.');
}

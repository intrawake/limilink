// Run against the isolated preview only. No chat POSTs or provider calls.
async page => {
    if (!page.url().startsWith('http://127.0.0.1:11012/')) throw new Error('Use the isolated fixture.');
    const check = (value, message) => { if (!value) throw new Error(message); };
    await page.setViewportSize({ width: 1440, height: 900 });
    const now = Date.now();
    const sample = {
        version: 1, sessionId: 'pi-a', updatedAt: now, state: 'working', model: 'test/parent', subagentsAvailable: true,
        context: { tokens: 48000, contextWindow: 100000, percent: 48, observedAt: now, basis: 'estimate' },
        tools: [{ id: 'read-1', name: 'read', startedAt: now }],
        nodes: [
            { id: 'parent', parentId: null, label: 'Assistant', kind: 'agent', state: 'working' },
            { id: 'child-1', parentId: 'parent', label: 'Review activity bridge', kind: 'agent', state: 'running', model: 'test/specialist',
                context: { tokens: 12000, contextWindow: 100000, percent: 12, observedAt: now, basis: 'last-input' }, currentTool: 'read' },
            { id: 'child-2', parentId: 'parent', label: 'Check UI <img src=x>', kind: 'agent', state: 'complete', model: 'test/worker' }
        ],
        edges: [
            { id: 'e1', source: 'parent', target: 'child-1', kind: 'delegation', label: 'task' },
            { id: 'e2', source: 'parent', target: 'child-2', kind: 'delegation', label: 'task' },
            { id: 'e3', source: 'child-2', target: 'parent', kind: 'reply', label: 'reply observed', at: now }
        ],
        events: [{ id: 'event1', kind: 'tool', label: 'Started read', at: now }]
    };
    let calls = 0, posts = 0, revision = 'a1', missing = false;
    let hold = false, held = null, heldReady = null;
    const countPosts = request => { if (request.method() === 'POST' && request.url().endsWith('/chat')) posts++; };
    page.on('request', countPosts);
    await page.route('**/sessions/*/activity*', async route => {
        calls++;
        const url = route.request().url();
        if (url.includes('/session_b/')) return route.fulfill({ json: { available: false, live: false, serverTime: Date.now(), reason: 'No activity for Beta yet.' } });
        if (hold) { held = route; heldReady(); return; }
        if (missing) return route.fulfill({ status: 503, json: {} });
        await route.fulfill({ json: { available: true, live: true, serverTime: Date.now(), revision, ...(url.includes(`revision=${encodeURIComponent(revision)}`) ? {} : { activity: sample }) } });
    });
    await page.goto('http://127.0.0.1:11012/');
    await page.waitForFunction(() => currentSession && !document.querySelector('#new-session-btn').disabled);
    await page.locator('.session-row[data-session-id="session_a"] .session-link').click();
    await page.waitForFunction(() => activeSnapshot === null);
    check(calls === 0, 'Collapsed panel polled activity');
    await page.locator('#message-input').fill('Keep my draft');
    const originalMessage = await page.locator('.message').first().elementHandle();
    await page.locator('#activity-toggle').click();
    await page.locator('.activity-node').nth(2).waitFor();
    check(await page.locator('#activity-panel').isVisible(), 'Panel did not open');
    check((await page.locator('#activity-status').innerText()).startsWith('Live'), 'Live status missing');
    check(await page.locator('.activity-edge').count() === 3, 'Directed edges missing');
    check(await page.locator('.activity-node[data-id="parent"]').innerText().then(text => text.includes('48%') && text.includes('read')), 'Context/tool missing');
    check(await page.locator('#activity-graph img').count() === 0, 'Label interpreted as HTML');
    await page.locator('.activity-node[data-id="child-1"]').click();
    check((await page.locator('#activity-detail').innerText()).includes('not current occupancy'), 'Child measurement mislabeled');
    await page.locator('#activity-detail button').first().click();
    check((await page.locator('.activity-edge-detail').innerText()).includes('delegation'), 'Edge details missing');
    await page.screenshot({ path: '.playwright-cli/limilink-activity-desktop.png' });
    // Polling preserves the focused graph node, draft and chat DOM.
    await page.locator('.activity-node[data-id="child-1"]').focus();
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await page.waitForFunction(() => document.querySelector('#activity-status').textContent.startsWith('Live'));
    check(await page.evaluate(() => document.activeElement.dataset.id) === 'child-1', 'Polling stole card focus');
    check(await originalMessage.evaluate(node => node.isConnected), 'Activity replaced chat DOM');
    check(await page.locator('#message-input').inputValue() === 'Keep my draft', 'Activity changed draft');
    // Unknown occupancy after compaction is not represented as 0%.
    sample.context.tokens = null; sample.context.percent = null; revision = 'a2';
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await page.waitForFunction(() => document.querySelector('.activity-node[data-id="parent"]').textContent.includes('unknown'));
    check(!(await page.locator('.activity-node[data-id="parent"]').innerText()).includes('0%'), 'Unknown context shown as zero');
    missing = true;
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await page.waitForFunction(() => document.querySelector('#activity-status').textContent.includes('Showing last observation'));
    check(await page.locator('.activity-node').count() === 3, 'Transient error erased graph');
    check(await page.locator('#send-btn').isEnabled(), 'Activity failure disabled Send');
    missing = false;
    // A late response from A must not paint over B.
    const captured = new Promise(resolve => { heldReady = resolve; }); hold = true;
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await captured;
    await page.locator('.session-row[data-session-id="session_b"] .session-link').click();
    await page.waitForFunction(() => document.querySelector('#activity-status').textContent.includes('Beta'));
    await held.fulfill({ json: { available: true, live: true, revision: 'old', serverTime: Date.now(), activity: sample } }).catch(() => {});
    hold = false;
    check(await page.locator('.activity-node').count() === 0, 'Old session graph leaked into B');
    await page.locator('.session-row[data-session-id="session_a"] .session-link').click();
    await page.locator('.activity-node').nth(2).waitFor();
    await page.locator('#activity-close').click();
    const closedCalls = calls;
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    check(await page.locator('#activity-panel').isHidden(), 'Panel did not collapse');
    check(calls === closedCalls, 'Closed panel fetched activity');
    // Phone drawer is modal, keyboard accessible, and fits the viewport.
    await page.setViewportSize({ width: 390, height: 844 });
    await page.locator('#activity-toggle').click();
    await page.locator('.activity-node').first().waitFor();
    check(await page.locator('#activity-panel').getAttribute('aria-modal') === 'true', 'Phone drawer is not modal');
    check(await page.evaluate(() => document.querySelector('#conversation').inert), 'Phone chat not inert');
    const bounds = await page.locator('#activity-panel').boundingBox();
    check(bounds.x >= 0 && bounds.x + bounds.width <= 391, 'Panel overflows phone viewport');
    await page.screenshot({ path: '.playwright-cli/limilink-activity-phone.png' });
    await page.locator('#activity-close').focus();
    await page.keyboard.press('Shift+Tab');
    check(await page.evaluate(() => document.querySelector('#activity-panel').contains(document.activeElement)), 'Focus escaped drawer');
    await page.keyboard.press('Escape');
    check(await page.locator('#activity-panel').isHidden(), 'Escape did not close drawer');
    check(await page.evaluate(() => document.activeElement.id) === 'activity-toggle', 'Close did not restore focus');
    check(await page.evaluate(() => !document.querySelector('#conversation').inert && document.querySelector('#session-sidebar').inert), 'Close broke drawer inert state');
    check(await page.locator('#message-input').inputValue() === 'Keep my draft', 'Navigation lost draft');
    check(posts === 0, 'Activity unexpectedly sent a message');
    await page.unroute('**/sessions/*/activity*'); page.off('request', countPosts);
    await page.setViewportSize({ width: 1440, height: 900 });
    return { passed: true, calls, chatPosts: posts, providers: 0, desktopAndPhone: true };
}

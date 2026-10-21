// Run against the isolated preview only. No chat POSTs or provider calls.
async page => {
    if (!page.url().startsWith('http://127.0.0.1:11012/')) throw new Error('Use the isolated fixture.');
    const check = (value, message) => { if (!value) throw new Error(message); };
    const timezone = await page.context().newCDPSession(page);
    await timezone.send('Emulation.setTimezoneOverride', { timezoneId: 'America/Los_Angeles' });
    await page.setViewportSize({ width: 1440, height: 900 });
    const now = Date.now();
    const daytime = Date.UTC(2026, 9, 21, 18, 0, 0);
    const winter = Date.UTC(2026, 0, 21, 19, 0, 0);
    const midnight = Date.UTC(2026, 9, 21, 7, 0, 0);
    const usageLine = 'Model · cached 9k · in 12.3k · out 678';
    const sample = {
        version: 1, sessionId: 'pi-a', updatedAt: now, state: 'working', model: 'test/parent', subagentsAvailable: true,
        context: { tokens: 48000, contextWindow: 100000, percent: 48, observedAt: now, basis: 'estimate' },
        tools: [{ id: 'read-1', name: 'read', startedAt: now }],
        nodes: [
            { id: 'parent', parentId: null, label: 'Assistant', kind: 'agent', state: 'working' },
            { id: 'child-1', parentId: 'parent', label: 'Review activity bridge', kind: 'agent', state: 'running', model: 'test/specialist',
                context: { tokens: 12000, contextWindow: 100000, percent: 12, observedAt: daytime, basis: 'last-input' }, currentTool: 'read' },
            { id: 'child-2', parentId: 'parent', label: 'Check UI <img src=x>', kind: 'agent', state: 'complete', model: 'test/worker' },
            { id: 'step-1', parentId: 'child-1', label: 'Review activity bridge', kind: 'step', state: 'complete', currentTool: 'read' }
        ],
        edges: [
            { id: 'e1', source: 'parent', target: 'child-1', kind: 'delegation', label: 'task' },
            { id: 'e2', source: 'parent', target: 'child-2', kind: 'delegation', label: 'task' },
            { id: 'e3', source: 'child-2', target: 'parent', kind: 'reply', label: 'reply observed', at: daytime },
            { id: 'e4', source: 'child-1', target: 'step-1', kind: 'delegation', label: 'delegation' }
        ],
        events: [
            { id: 'event1', kind: 'model', label: usageLine, at: daytime, nodeId: 'parent' },
            { id: 'event2', kind: 'tool', label: 'Finished read · 123ms', at: winter, nodeId: 'parent' },
            { id: 'event3', kind: 'model', label: 'Model response · usage not reported', at: midnight, nodeId: 'parent' }
        ]
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
    check(/^Live · \d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} P[DS]T$/.test(await page.locator('#activity-status').innerText()), 'Status timestamp is not local dated 24-hour time');
    check(await page.locator('.activity-edge').count() === 4, 'Directed edges missing');
    check(await page.locator('.activity-node[data-id="parent"]').innerText().then(text => text.includes('48%') && text.includes('read')), 'Context/tool missing');
    check(await page.locator('#activity-graph img').count() === 0, 'Label interpreted as HTML');
    await page.locator('#activity-events summary').click();
    check(await page.locator('#activity-events').getByText(usageLine, { exact: true }).isVisible(), 'Per-response token categories missing');
    check(await page.locator('#activity-events').getByText('read · 123ms', { exact: true }).isVisible(), 'Compact successful tool label/duration missing');
    check(await page.locator('#activity-events').getByText('Model response · usage not reported', { exact: true }).isVisible(), 'Unknown usage was hidden or invented');
    check((await page.locator('#activity-events time').allTextContents()).join('|') === '2026-10-21 00:00:00 PDT|2026-01-21 11:00:00 PST|2026-10-21 11:00:00 PDT', 'Event timestamps mishandle date, midnight, timezone or daylight saving');
    await page.locator('.activity-node[data-id="child-1"]').click();
    check((await page.locator('#activity-detail').innerText()).includes('not current occupancy'), 'Child measurement mislabeled');
    check((await page.locator('#activity-events summary').innerText()).includes('Review activity bridge'), 'History owner is unclear');
    check(await page.locator('#activity-events [data-event-id]').count() === 0, 'Main-agent events appeared as child history');
    check((await page.locator('#activity-events').innerText()).includes('Per-tool history is not reported'), 'Missing child history was presented as reported work');
    check((await page.locator('#activity-detail').innerText()).includes('2026-10-21 11:00:00 PDT'), 'Context measurement timestamp has wrong format');
    const childUsage = 'Reported run total · cached 9k · in 1.2k · out 56';
    sample.nodes[1].model = 'provider/reported';
    sample.events.push({ id: 'child-usage', kind: 'usage', label: childUsage, at: now, nodeId: 'child-1' });
    revision = 'child-usage';
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await page.waitForFunction(() => document.querySelector('[data-id="child-1"] .activity-model').textContent.includes('provider/reported'));
    check((await page.locator('[data-id="child-1"] .activity-model').innerText()).startsWith('Reported model:'), 'Package model was presented as provider-confirmed');
    check((await page.locator('#activity-detail').innerText()).includes('Reported model'), 'Model provenance missing in details');
    check(await page.locator('#activity-events').getByText(childUsage, { exact: true }).isVisible(), 'Child-owned reported run usage missing');
    check(await page.locator('#activity-events [data-event-id]').count() === 1, 'Run totals borrowed main-agent history');
    check((await page.locator('#activity-events').innerText()).includes('not context occupancy or usage attributed to one model'), 'Run totals overstated their basis');
    check((await page.locator('#activity-events').innerText()).includes('Per-tool history is not reported'), 'Run totals implied per-tool history');
    await page.locator('#activity-detail button').first().click();
    check((await page.locator('.activity-edge-detail').innerText()).includes('delegation'), 'Edge details missing');
    await page.locator('.activity-node[data-id="child-2"]').click();
    await page.locator('#activity-detail button').filter({ hasText: 'reply observed' }).click();
    check((await page.locator('.activity-edge-detail').innerText()).includes('2026-10-21 11:00:00 PDT'), 'Connection timestamp has wrong format');
    await page.locator('.activity-node[data-id="step-1"]').click();
    check((await page.locator('.activity-node[data-id="step-1"]').innerText()).includes('Execution step:'), 'Legacy execution row looks like a second agent');
    check((await page.locator('.activity-node[data-id="step-1"]').innerText()).includes('Last observed tool:'), 'Terminal step looks like current execution');
    check((await page.locator('#activity-detail h3').innerText()).startsWith('Execution step:'), 'Execution detail looks like another agent');
    await page.locator('#activity-detail button').first().click();
    check((await page.locator('.activity-edge-detail').innerText()).includes('execution: Execution step'), 'Execution containment was shown as another delegation');
    check(await page.locator('#activity-events [data-event-id]').count() === 0, 'Execution step inherited main-agent history');
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
    sample.context = null;
    sample.events.push({ id: 'compact-1', kind: 'context', label: 'Context compacted', at: now, nodeId: 'parent' });
    revision = 'a3';
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await page.waitForFunction(() => document.querySelector('.activity-node[data-id="parent"]').textContent.includes('Compacted · awaiting fresh usage'));
    check(!(await page.locator('.activity-node[data-id="parent"]').innerText()).includes('48%'), 'Old occupancy survived compaction');
    check((await page.locator('.activity-node[data-id="parent"]').getAttribute('aria-label')).includes('Compacted · awaiting fresh usage'), 'Accessible compaction state missing');
    await page.locator('.activity-node[data-id="parent"]').click();
    check((await page.locator('#activity-detail').innerText()).includes('Compacted · awaiting fresh usage'), 'Context detail retained stale usage');
    check(await page.locator('#activity-events').getByText(childUsage, { exact: true }).count() === 0, 'Child totals leaked into main-agent history');
    check(!(await page.locator('#activity-detail').innerText()).includes('Measured'), 'Pre-compaction measurement retained');
    check((await page.locator('.activity-node[data-id="child-1"]').innerText()).includes('12%'), 'Parent compaction invalidated a child reading');
    sample.context = { tokens: 5000, contextWindow: 100000, percent: 5, observedAt: now, basis: 'estimate' }; revision = 'a4';
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await page.waitForFunction(() => document.querySelector('.activity-node[data-id="parent"]').textContent.includes('5%'));
    check(!(await page.locator('.activity-node[data-id="parent"]').innerText()).includes('awaiting fresh usage'), 'Fresh context did not clear waiting state');
    missing = true;
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await page.waitForFunction(() => document.querySelector('#activity-status').textContent.includes('Showing last observation'));
    check(await page.locator('.activity-node').count() === 4, 'Transient error erased graph');
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
    check(await page.locator('#activity-events').evaluate(node => node.scrollWidth <= node.clientWidth + 1), 'Token summaries overflow phone panel');
    check(await page.locator('#activity-events').getByText(usageLine, { exact: true }).evaluate(node => node.getBoundingClientRect().height <= parseFloat(getComputedStyle(node).lineHeight) + 1), 'Compact token summary wraps on phone');
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
    await timezone.send('Emulation.setTimezoneOverride', { timezoneId: '' });
    await timezone.detach();
    await page.setViewportSize({ width: 1440, height: 900 });
    return { passed: true, calls, chatPosts: posts, providers: 0, desktopAndPhone: true };
}

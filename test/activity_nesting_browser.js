// Isolated fixture only: no chat POSTs, provider calls or live-session mutation.
async page => {
    if (!page.url().startsWith('http://127.0.0.1:11012/')) throw new Error('Use the isolated fixture.');
    const check = (value, message) => { if (!value) throw new Error(message); };
    const now = Date.now();
    const tool = (id, label, parentEventId, state = 'running') => ({ id, kind: 'tool', label, parentEventId, state, at: now, nodeId: 'parent' });
    const sample = {
        version: 1, sessionId: 'nested-fixture', updatedAt: now, state: 'working', model: 'test/model', subagentsAvailable: false,
        context: { tokens: 20, contextWindow: 100, percent: 20, basis: 'estimate', observedAt: now },
        nodes: [{ id: 'parent', label: 'Parent', kind: 'agent', state: 'working' },
            { id: 'other-agent', label: 'Other agent', kind: 'agent', state: 'complete' }], edges: [], tools: [],
        events: [
            { id: 'model', kind: 'model', label: 'Model · cached 9k · in 12.3k · out 678', at: now, nodeId: 'parent' },
            tool('outer', 'Running codemode'), tool('a', 'Running read', 'outer'), tool('b', 'Running bash', 'outer'),
            tool('unrelated', 'Running read'), tool('deep', 'Running read', 'a'), tool('orphan', 'Finished read', 'missing', 'finished'),
            { id: 'legacy', kind: 'tool', label: 'Finished legacy tool', at: now }
        ]
    };
    let revision = 0, posts = 0, calls = 0;
    const countPosts = request => { if (request.method() === 'POST' && request.url().endsWith('/chat')) posts++; };
    page.on('request', countPosts);
    await page.route('**/sessions/*/activity*', async route => {
        calls++;
        await route.fulfill({ json: { available: true, live: true, revision: `nested-${revision}`, serverTime: Date.now(), activity: sample } });
    });
    const row = id => page.locator(`#activity-events li[data-event-id="${id}"]`);
    const refresh = async () => { revision++; await page.evaluate(() => window.dispatchEvent(new Event('focus'))); };
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto('http://127.0.0.1:11012/');
    await page.waitForFunction(() => currentSession && !document.querySelector('#new-session-btn').disabled);
    await page.locator('.session-row[data-session-id="session_a"] .session-link').click();
    await page.waitForFunction(() => activeSnapshot === null);
    await page.locator('#message-input').fill('Preserve the nesting draft');
    const chat = await page.locator('.message').first().elementHandle();
    await page.locator('#activity-toggle').click();
    await page.locator('#activity-events summary').click();
    await row('outer').waitFor();
    check(await page.locator('#activity-events li').count() === 8, 'Initial activity rows lost/duplicated');
    check((await page.locator('#activity-events > ol > li').evaluateAll(rows => rows.map(row => row.dataset.eventId))).join(',') === 'legacy,orphan,unrelated,outer,model', 'Root groups are not newest-first');
    check((await row('outer').locator(':scope > ol > li').evaluateAll(rows => rows.map(row => row.dataset.eventId))).join(',') === 'a,b', 'Parallel children not in observed call order');
    check(await row('a').locator(':scope > ol > li[data-event-id="deep"]').count() === 1, 'Deeper codemode nesting missing');
    check(await row('outer').locator('li[data-event-id="unrelated"]').count() === 0, 'Unrelated same-name tool was guessed to be nested');
    check((await row('orphan').innerText()).includes('Parent outside recent history'), 'Orphan call hidden or misrepresented');
    const labelLeft = id => row(id).locator(':scope > .activity-event-row > .activity-event-label').evaluate(node => node.getBoundingClientRect().left);
    check(await labelLeft('a') - await labelLeft('outer') >= 24, 'Child label indentation is too subtle');
    check(await labelLeft('deep') - await labelLeft('a') >= 24, 'Second nesting level is not visibly indented');
    check(await row('a').locator(':scope > .activity-event-row > .activity-event-branch[aria-hidden="true"]').innerText() === '↳', 'Explicit child branch marker missing');
    check(await row('a').evaluate(node => getComputedStyle(node).borderBottomWidth) === '0px', 'Child still has a misleading horizontal separator');
    check(await row('legacy').locator('.activity-event-label').innerText() === 'legacy tool', 'Legacy successful prefix was not removed');
    check(await row('unrelated').locator('.activity-event-label').innerText() === 'Running read', 'Running state lost its label');
    // Completion mutates the same logical rows; it must not append a second pair.
    sample.events.find(event => event.id === 'b').state = 'failed';
    sample.events.find(event => event.id === 'b').label = 'Failed bash · 20ms';
    sample.events.find(event => event.id === 'outer').state = 'finished';
    sample.events.find(event => event.id === 'outer').label = 'Finished codemode · 50ms';
    await refresh();
    await page.waitForFunction(() => document.querySelector('[data-event-id="outer"]').dataset.state === 'finished');
    check(await page.locator('#activity-events li').count() === 8, 'Completion appended duplicate rows');
    check(await row('a').getAttribute('data-state') === 'running', 'Parent completion hid an unfinished child');
    check(await row('b').getAttribute('data-state') === 'failed', 'Nested error state missing');
    check(await row('b').locator('.activity-event-label').innerText() === 'Failed bash · 20ms', 'Failure label hidden');
    check(await row('outer').locator(':scope > .activity-event-row > .activity-event-label').innerText() === 'codemode · 50ms', 'Finished prefix remains on successful wrapper');
    check(!(await row('outer').locator(':scope > .activity-event-row').innerText()).includes('Running codemode'), 'Old start line survived completion');
    sample.events.find(event => event.id === 'a').state = 'finished'; sample.events.find(event => event.id === 'a').label = 'Finished read · 40ms';
    await refresh();
    await page.waitForFunction(() => document.querySelector('[data-event-id="a"]').dataset.state === 'finished');
    check((await row('outer').locator(':scope > ol > li').evaluateAll(rows => rows.map(row => row.dataset.eventId))).join(',') === 'a,b', 'Reverse completions reordered child calls');
    check(await row('unrelated').getAttribute('data-state') === 'running', 'Completing one read collapsed another execution');
    check(await row('a').locator(':scope > .activity-event-row > .activity-event-label').innerText() === 'read · 40ms', 'Finished prefix remains on successful child');
    check(await chat.evaluate(node => node.isConnected), 'Timeline update replaced chat DOM');
    check(await page.locator('#message-input').inputValue() === 'Preserve the nesting draft', 'Timeline update changed draft');
    await page.screenshot({ path: '.playwright-cli/limilink-activity-nesting-desktop.png' });
    // Corrupt/partial histories must render once, remain text-only, and never loop.
    const malformed = [
        tool('cycle-a', 'Cycle A', 'cycle-b', 'finished'), tool('cycle-b', 'Cycle B', 'cycle-a', 'finished'),
        tool('self', 'Self link', 'self', 'finished'), tool('missing-parent', 'Orphan', 'absent', 'finished'),
        { id: 'model-parent', kind: 'model', label: 'Model event', at: now, nodeId: 'parent' },
        tool('wrong-kind', 'Not a child of a model row', 'model-parent', 'finished'),
        { ...tool('other-agent', 'Different agent', 'chain-0', 'finished'), nodeId: 'other-agent' },
        tool('__proto__', '<img src=x> text only', undefined, 'finished')
    ];
    for (let i = 0; i < 12; i++) malformed.push(tool(`chain-${i}`, `Finished nested tool ${i}`, i ? `chain-${i - 1}` : undefined, 'finished'));
    malformed.push({ ...malformed[0], label: 'Duplicate identity' });
    sample.events = malformed;
    await refresh();
    await row('chain-11').waitFor();
    check(await page.locator('#activity-events li').count() === 19, 'Cycle/duplicate/owner handling hid or duplicated main-agent rows');
    check(await row('wrong-kind').evaluate(node => node.parentElement.parentElement.id === 'activity-events'), 'Non-tool parent accepted');
    check(await row('other-agent').count() === 0, 'Another agent\'s event leaked into main-agent history');
    await page.locator('.activity-node[data-id="other-agent"]').click();
    check(await page.locator('#activity-events [data-event-id]').count() === 1, 'Explicit child-owned history was hidden or mixed with main events');
    check(await row('other-agent').evaluate(node => node.parentElement.parentElement.id === 'activity-events'), 'Cross-agent parent accepted');
    check((await row('other-agent').innerText()).includes('Nesting unavailable'), 'Invalid cross-agent nesting was not explained');
    sample.nodes = sample.nodes.filter(node => node.id !== 'other-agent');
    await refresh();
    await page.waitForFunction(() => document.querySelector('.activity-node[data-id="parent"]').getAttribute('aria-pressed') === 'true');
    check(await row('other-agent').count() === 0 && await row('chain-0').count() === 1, 'Disappearing selection did not restore main-agent history');
    check(await page.locator('#activity-events img').count() === 0, 'Event label interpreted as HTML');
    await page.setViewportSize({ width: 390, height: 844 });
    await page.waitForFunction(() => document.querySelector('#activity-panel').getAttribute('aria-modal') === 'true');
    check(await page.locator('#activity-events').evaluate(node => node.scrollWidth <= node.clientWidth + 1), 'Deep hierarchy overflowed phone');
    check(await labelLeft('chain-1') - await labelLeft('chain-0') >= 24, 'Phone nesting is too subtle');
    const deepLeft = await row('chain-11').evaluate(node => node.getBoundingClientRect().left);
    const cappedLeft = await row('chain-3').evaluate(node => node.getBoundingClientRect().left);
    check(Math.abs(deepLeft - cappedLeft) <= 1, 'Visual indentation did not stop at the depth cap');
    check(await page.locator('#message-input').inputValue() === 'Preserve the nesting draft', 'Phone layout lost draft');
    await page.screenshot({ path: '.playwright-cli/limilink-activity-nesting-phone.png' });
    // Removing the focused card leaves focus outside the panel; do not demand
    // background autofocus. Give the dismissal shortcut its normal panel focus.
    await page.locator('#activity-close').focus();
    await page.keyboard.press('Escape');
    check(await page.locator('#activity-panel').isHidden(), 'Nested pane did not dismiss');
    check(posts === 0, 'Timeline sent a chat request');
    await page.unroute('**/sessions/*/activity*'); page.off('request', countPosts);
    await page.setViewportSize({ width: 1440, height: 900 });
    return { passed: true, calls, chatPosts: posts, providers: 0, nestedUpdates: true, malformedHistory: true, phoneDepthCap: true };
}

// Isolated DOM contracts only; no provider calls, chat POSTs or visual approval.
async page => {
    if (!page.url().startsWith('http://127.0.0.1:11012/')) throw new Error('Use the isolated preview.');
    const check = (value, message) => { if (!value) throw new Error(message); };
    let revision = 0, posts = 0, live = true;
    const countPosts = request => { if (request.method() === 'POST') posts++; };
    page.on('request', countPosts);
    const now = Date.now();
    const observed = (id, state, status = 'open', parentId = 'parent') => ({
        id, parentId, label: `Child ${id}`, kind: 'agent', state,
        observation: { basis: 'pi-session-events', status, ancestry: 'file-reference', observedAt: now, omitted: 0 }
    });
    const native = (id, state) => ({ id, parentId: 'parent', label: id, kind: 'agent', state });
    // Deliberately put history before current nodes in source order.
    const sample = { version: 1, updatedAt: now, state: 'working', model: 'fixture', subagentsAvailable: true,
        sessionTracking: { available: true, limited: false }, context: null, tools: [],
        nodes: [native('parent', 'working'), observed('closed-child', 'closed', 'closed'),
            native('async:done', 'complete'), observed('idle-child', 'idle'),
            observed('stale-child', 'working', 'stale'), observed('conflict-child', 'unknown', 'conflict'),
            native('async:unknown', 'unknown'), native('async:paused', 'paused'), native('async:queued', 'queued'),
            observed('closed-nested', 'closed', 'closed', 'closed-child')],
        edges: [
            { id: 'cross', source: 'parent', target: 'closed-child', kind: 'ancestry', label: 'Historical parent file' },
            { id: 'history', source: 'closed-child', target: 'closed-nested', kind: 'ancestry', label: 'Historical parent file' },
            { id: 'current', source: 'parent', target: 'idle-child', kind: 'ancestry', label: 'Historical parent file' },
            { id: 'resumed', source: 'closed-child', target: 'idle-child', kind: 'ancestry', label: 'Historical parent file' }
        ], events: [
            { id: 'closed-read', nodeId: 'closed-child', kind: 'tool', state: 'finished', label: 'Finished read · 2ms', at: now },
            { id: 'idle-read', nodeId: 'idle-child', kind: 'tool', state: 'finished', label: 'Finished read · 1ms', at: now }
        ] };
    await page.route('**/sessions/*/activity*', route => route.fulfill({ json: {
        available: true, live, serverTime: Date.now(), revision: String(revision), activity: sample
    } }));
    const refresh = async () => { revision++; await page.evaluate(() => window.dispatchEvent(new Event('focus'))); };
    const card = id => page.locator(`#activity-graph .activity-node[data-id="${id}"]`);
    const group = async (id, expected) => check(await card(id).getAttribute('data-group') === expected, `${id} should be ${expected}`);
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto('http://127.0.0.1:11012/');
    await page.waitForFunction(() => currentSession && !document.querySelector('#new-session-btn').disabled);
    await page.locator('.session-row[data-session-id="session_a"] .session-link').click();
    await page.locator('#message-input').fill('Keep history grouping draft');
    const chat = await page.locator('.message').first().elementHandle();
    await page.locator('#activity-toggle').click();
    await card('closed-child').waitFor();
    check(await page.locator('#activity-current-heading').innerText() === 'Current observations', 'Current heading missing');
    check(await page.locator('#activity-history-heading').innerText() === 'Recent history', 'History heading missing');
    for (const id of ['closed-child', 'closed-nested']) await group(id, 'history');
    for (const id of ['parent', 'idle-child', 'stale-child', 'conflict-child']) await group(id, 'current');
    check(await page.locator('.activity-node[data-id^="async:"]').count() === 0, 'Native states displayed as observed agents');
    check(await card('closed-child').getAttribute('aria-describedby') === 'activity-history-heading', 'History has no accessible group label');
    const layout = async () => page.evaluate(() => {
        const graph = document.querySelector('#activity-graph'), cards = [...graph.querySelectorAll('.activity-node')];
        const tops = cards.map(card => parseFloat(card.style.top));
        const height = parseFloat(graph.style.height);
        return { ordered: tops.every((top, i) => !i || top > tops[i - 1]),
            bounded: tops.every(top => top + 108 <= height),
            svgHeight: graph.querySelector('svg').viewBox.baseVal.height, height,
            paths: graph.querySelectorAll('path.activity-edge').length,
            groups: [...graph.children].filter(node => node.tagName !== 'svg').map(node => node.dataset.group) };
    });
    let geometry = await layout();
    check(geometry.ordered && geometry.bounded && geometry.svgHeight === geometry.height, 'Section layout/keyboard order incorrect');
    check(geometry.paths === 4, 'Grouping lost existing graph relationships');
    check(geometry.groups.join(',').indexOf('history,current') === -1, 'History heading precedes current cards in DOM');
    await page.locator('#activity-events summary').click();
    await card('closed-child').click();
    check((await page.locator('#activity-detail').innerText()).includes('Recent history · observer closed; not current activity'), 'Closed observation looks current');
    check((await page.locator('#activity-detail').innerText()).includes('does not establish native task success'), 'Closure overclaims success');
    check(await page.locator('[data-event-id="closed-read"]').count() === 1, 'History tool inspection lost');
    const cross = page.locator('#activity-detail button[data-edge="cross"]');
    check(await cross.count() === 1, 'Cross-section relationship lost from Connections');
    await cross.click();
    check((await page.locator('.activity-edge-detail').innerText()).includes('ancestry:'), 'Cross-section relationship detail unavailable');
    await card('idle-child').click();
    await card('idle-child').focus();
    sample.nodes.find(node => node.id === 'idle-child').state = 'closed';
    sample.nodes.find(node => node.id === 'idle-child').observation.status = 'closed';
    await refresh();
    await page.waitForFunction(() => document.querySelector('[data-id="idle-child"]').dataset.group === 'history');
    check(await page.evaluate(() => document.activeElement.dataset.id) === 'idle-child', 'Moving to history stole card focus');
    check((await page.locator('#activity-detail').innerText()).includes('Recent history'), 'Selection lost on closure');
    check(await page.locator('[data-event-id="idle-read"]').count() === 1, 'Selected history changed ownership');
    // Native reports remain hidden regardless of terminal or uncertain status.
    for (const state of ['failed', 'partial', 'stopped', 'rejected']) sample.nodes.push(native(`async:${state}`, state));
    sample.nodes.push(observed('new-child', 'working'));
    live = false; await refresh();
    await card('new-child').waitFor();
    check(await page.locator('.activity-node[data-id^="async:"]').count() === 0, 'Terminal native history boxes reappeared');
    for (const id of ['new-child', 'stale-child', 'conflict-child']) await group(id, 'current');
    await page.setViewportSize({ width: 390, height: 844 });
    await page.waitForFunction(() => document.querySelector('#activity-panel').getAttribute('role') === 'dialog');
    geometry = await layout();
    check(geometry.ordered && geometry.bounded && geometry.svgHeight === geometry.height, 'Resize lost section geometry');
    check(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), 'Phone horizontal overflow');
    await card('closed-child').click();
    check(await page.locator('[data-event-id="closed-read"]').count() === 1, 'Phone history inaccessible');
    // No retained history: remove its heading and recover selection normally.
    sample.nodes = sample.nodes.filter(node => node.id === 'parent' || !['closed', 'complete', 'failed', 'partial', 'stopped', 'rejected'].includes(node.state));
    await refresh();
    await page.waitForFunction(() => !document.querySelector('#activity-history-heading'));
    check(await card('parent').getAttribute('aria-pressed') === 'true', 'Evicted selection did not recover');
    await page.locator('#activity-close').click();
    check(await page.locator('#message-input').inputValue() === 'Keep history grouping draft', 'Draft changed');
    check(await chat.evaluate(node => node.isConnected), 'Chat DOM replaced');
    check(await page.locator('#send-btn').isEnabled(), 'History grouping changed Send readiness');
    check(posts === 0, `Unexpected POSTs: ${posts}`);
    await page.unroute('**/sessions/*/activity*'); page.off('request', countPosts);
    return { desktop: true, emulatedPhone: true, explicitClosureOnly: true, retainedHistory: true, preservedFocus: true, posts };
}

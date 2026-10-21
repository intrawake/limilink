// Requires isolated --fake-chat preview; only local echo POSTs, never providers.
async page => {
    const base = 'http://127.0.0.1:11012';
    if (!page.url().startsWith(base + '/')) throw new Error('Use the isolated preview.');
    const check = (value, message) => { if (!value) throw new Error(message); };
    const key = 'limilink_activity_dismissals_v1';
    await page.evaluate(key => sessionStorage.removeItem(key), key);
    let revision = 0, hold = false, held, captured;
    const now = Date.now();
    const child = (id, status = 'closed', parentId = 'parent') => ({ id, parentId, label: id, kind: 'agent', state: status === 'closed' ? 'closed' : 'working',
        observation: { basis: 'pi-session-events', status, ancestry: 'file-reference', observedAt: now, omitted: 0 } });
    const sample = { version: 1, updatedAt: now, state: 'working', model: 'fixture', tools: [], context: null,
        sessionTracking: { available: true, limited: false }, subagentsAvailable: true,
        nodes: [ { id: 'parent', label: 'Main agent', kind: 'agent', state: 'working' }, child('old'), child('later', 'open'),
            child('descendant', 'open', 'old'), child('stale', 'stale'), child('conflict', 'conflict'), child('unknown', 'unknown'),
            { id: 'async:native', parentId: 'parent', label: 'worker', kind: 'agent', state: 'complete' } ],
        edges: [{ id: 'old-edge', source: 'parent', target: 'old', kind: 'ancestry', label: 'Historical parent file' },
            { id: 'descendant-edge', source: 'old', target: 'descendant', kind: 'ancestry', label: 'Historical parent file' }],
        events: [{ id: 'old-read', nodeId: 'old', kind: 'tool', state: 'finished', label: 'Finished read · 2ms', at: now }] };
    const handler = async route => {
        const response = { json: { available: true, live: true, serverTime: Date.now(), revision: String(revision), activity: JSON.parse(JSON.stringify(sample)) } };
        if (hold) { held = { route, response }; captured(); }
        else await route.fulfill(response);
    };
    await page.route('**/sessions/*/activity*', handler);
    const refresh = async () => { revision++; await page.evaluate(() => window.dispatchEvent(new Event('focus'))); };
    const boundary = (requestId, sessionId = 'session_a') => page.evaluate(({requestId, sessionId}) => {
        document.dispatchEvent(new CustomEvent('limilink:human-send', { detail: { requestId, sessionId } }));
    }, { requestId, sessionId });
    const card = id => page.locator(`#activity-graph .activity-node[data-id="${id}"]`);
    const ready = () => page.waitForFunction(() => !document.querySelector('#send-btn').disabled);
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(base + '/');
    await page.waitForSelector('.session-row');
    await page.locator('.session-row[data-session-id="session_a"] .session-link').click(); await ready();
    await page.locator('#activity-toggle').click(); await card('old').waitFor();
    await page.locator('#activity-events summary').click(); await card('old').click();
    check(await page.locator('[data-event-id="old-read"]').count() === 1, 'Closed result unavailable before next Send');
    // Real UI Send: exactly one event with opaque IDs, before exactly one local echo POST.
    await page.evaluate(() => { window.humanBoundaries = []; document.addEventListener('limilink:human-send', event => window.humanBoundaries.push(event.detail)); });
    let posts = 0, firstBody;
    const count = request => { if (request.method() === 'POST' && request.url().endsWith('/chat')) { posts++; firstBody ??= request.postDataJSON(); } };
    page.on('request', count);
    await page.locator('#message-input').fill('Local echo: child history boundary'); await page.locator('#send-btn').click();
    await page.waitForFunction(() => !document.querySelector('#activity-graph [data-id="old"]'));
    check(await card('async:native').count() === 0, 'Native run report exposed as another child box');
    check(sample.nodes.some(node => node.id === 'async:native'), 'Display filtering mutated source native state');
    for (const id of ['later', 'descendant', 'stale', 'conflict', 'unknown']) check(await card(id).count() === 1, `Uncertain/open ${id} hidden`);
    check(await card('parent').getAttribute('aria-pressed') === 'true', 'Hidden selection retained');
    check(await page.locator('#activity-detail [data-edge="old-edge"]').count() === 0, 'Hidden child remains in Connections');
    check(await page.locator('[data-event-id="old-read"]').count() === 0, 'Hidden child remains in event detail');
    await ready();
    const emitted = await page.evaluate(() => window.humanBoundaries);
    check(posts === 1 && emitted.length === 1, 'Send/refresh emitted duplicate boundary or POST');
    check(emitted[0].requestId === firstBody.request_id && emitted[0].sessionId === 'session_a', 'Boundary not linked to actual fresh Send');
    check(Object.keys(emitted[0]).sort().join(',') === 'requestId,sessionId', 'Message contents leaked into observer event');
    // An in-flight response reporting a new closure is not retrospectively dismissed.
    const later = sample.nodes.find(node => node.id === 'later'); later.state = 'closed'; later.observation.status = 'closed';
    hold = true;
    const arrived = new Promise(resolve => { captured = resolve; }); await refresh(); await arrived;
    await boundary('b'.repeat(32));
    hold = false; await held.route.fulfill(held.response);
    await page.waitForFunction(() => document.querySelector('[data-id="later"]').dataset.group === 'history');
    // Background refreshes, busy/parent changes and repeated Send events don't clear it.
    sample.state = 'idle'; await refresh(); await boundary(firstBody.request_id); await boundary('b'.repeat(32));
    check(await card('later').count() === 1, 'Callback/replayed boundary hid new closure');
    await card('later').focus(); await boundary('c'.repeat(32));
    check(await card('later').count() === 0, 'Next distinct Send did not dismiss observed closure');
    check(await page.evaluate(() => document.activeElement.dataset.id) === 'parent', 'Removed focused card has no fallback');
    // Changed record / reopened SDK ID reappears; no permanent ID blacklist.
    later.state = 'working'; later.observation.status = 'open'; await refresh(); await card('later').waitFor();
    later.state = 'closed'; later.observation.status = 'closed'; await refresh();
    await page.waitForFunction(() => document.querySelector('[data-id="later"]').dataset.group === 'history');
    check(await card('later').count() === 1, 'Resumed/reclosed same ID permanently hidden');
    await boundary('d'.repeat(32));
    const old = sample.nodes.find(node => node.id === 'old'); old.observation.observedAt++;
    await refresh(); await card('old').waitFor();
    check(await card('old').count() === 1, 'Changed closed record treated as identical evidence');
    await card('parent').click(); await page.locator('#activity-detail [data-edge="old-edge"]').focus();
    await boundary('e'.repeat(32));
    check(await page.evaluate(() => document.activeElement.dataset.id) === 'parent', 'Removed connection focus has no fallback');
    // Dismissal works from cached data with the panel closed and persists on reload.
    sample.nodes.push(child('cached')); await refresh(); await card('cached').waitFor();
    await page.locator('#activity-close').click(); await boundary('f'.repeat(32));
    await page.locator('#activity-toggle').click();
    check(await card('cached').count() === 0, 'Closed-panel cached evidence not dismissed');
    await page.reload(); await page.waitForSelector('.session-row'); await ready();
    await page.locator('#activity-toggle').click(); await card('parent').waitFor();
    check(await card('old').count() === 0 && await card('later').count() === 0 && await card('cached').count() === 0, 'Same-tab reload forgot dismissals');
    // No observation before a Send: fail open, and isolate conversations.
    await page.locator('#activity-close').click();
    await page.locator('.session-row[data-session-id="session_b"] .session-link').click(); await ready();
    await boundary('1'.repeat(32), 'session_b'); await page.locator('#activity-toggle').click(); await card('old').waitFor();
    check(await card('old').count() === 1, 'Unseen/different-conversation record dismissed');
    await boundary('2'.repeat(32), 'session_b'); check(await card('old').count() === 0, 'Second observed boundary did not dismiss');
    await page.locator('#activity-close').click();
    await page.locator('.session-row[data-session-id="session_a"] .session-link').click(); await ready();
    await page.locator('#activity-toggle').click(); await card('parent').waitFor();
    check(await card('old').count() === 0, 'Session switching lost isolation/dismissal');
    // Storage failure is local-only and cannot interfere with real Send.
    await page.locator('#activity-close').click();
    await page.evaluate(() => { Storage.prototype.setItem = () => { throw new Error('fixture unavailable'); }; });
    await page.locator('#message-input').fill('Local echo: storage unavailable'); await page.locator('#send-btn').click(); await ready();
    check(posts === 2, 'Storage failure blocked or duplicated Send');
    await page.reload(); await page.waitForSelector('.session-row'); await ready();
    await page.setViewportSize({ width: 390, height: 844 });
    await page.locator('#activity-toggle').click(); await card('parent').waitFor();
    check(await card('old').count() === 0, 'Phone lost same-tab dismissal');
    check(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), 'Phone horizontal overflow');
    await page.locator('#activity-close').click();
    await page.setViewportSize({ width: 1440, height: 900 });
    page.off('request', count); await page.unroute('**/sessions/*/activity*');
    return { passed: true, realHumanBoundary: true, exactRecordsOnly: true, reload: true, closedPanel: true,
        unseenFailsOpen: true, resumedIdentity: true, duplicateSafe: true, storageFailureSafe: true, localEchoPosts: posts, providerCalls: 0 };
}

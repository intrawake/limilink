// Isolated preview only; no chat POSTs/providers. Tests DOM contracts, not visual acceptance.
async page => {
    if (!page.url().startsWith('http://127.0.0.1:11012/')) throw new Error('Use the isolated preview.');
    const check = (value, message) => { if (!value) throw new Error(message); };
    let revision = 0, posts = 0;
    const post = request => { if (request.method() === 'POST') posts++; };
    page.on('request', post);
    const now = Date.now(), child = 'session:' + 'a'.repeat(32), nested = 'session:' + 'b'.repeat(32), native = 'async:' + 'c'.repeat(32);
    const observation = { basis: 'pi-session-events', status: 'open', ancestry: 'file-reference', observedAt: now, omitted: 2, modelBasis: 'response', selectedModel: 'selected/model', modelObservedAt: now, lastInputObservedAt: now };
    const sample = { version: 1, sessionId: 'main', updatedAt: now, state: 'working', model: 'main/model', subagentsAvailable: true,
        sessionTracking: { available: true, limited: false }, context: null, tools: [],
        nodes: [
            { id: 'parent', parentId: null, label: 'Main agent', kind: 'agent', state: 'working' },
            { id: child, parentId: 'parent', label: 'Child session aaaaaaaa', kind: 'agent', state: 'working', model: 'actual/response', lastInputTokens: 30000, currentTool: 'read', observation: { ...observation } },
            { id: nested, parentId: child, label: 'Child session bbbbbbbb', kind: 'agent', state: 'idle', model: 'selected/model', observation: { ...observation, modelBasis: 'selected', omitted: 0 } },
            { id: native, parentId: 'parent', label: 'worker', kind: 'agent', state: 'running', model: 'launch/model' },
            { id: 'async:workflow', parentId: 'parent', label: 'workflow', kind: 'workflow', state: 'running' },
            { id: 'async:step', parentId: 'async:workflow', label: 'step', kind: 'step', state: 'complete' }
        ], edges: [
            { id: 'ancestry-1', source: 'parent', target: child, kind: 'ancestry', label: 'Header parent file (historical)' },
            { id: 'ancestry-2', source: child, target: nested, kind: 'ancestry', label: 'Header parent file (historical)' },
            { id: 'native-edge', source: 'parent', target: native, kind: 'delegation', label: 'delegation' },
            { id: 'workflow-edge', source: 'parent', target: 'async:workflow', kind: 'delegation', label: 'delegation' },
            { id: 'step-edge', source: 'async:workflow', target: 'async:step', kind: 'delegation', label: 'Execution step' }
        ], events: [
            { id: 'parent-event', nodeId: 'parent', at: now, kind: 'model', label: 'Model · cached 1k · in 200 · out 10' },
            { id: 'child-model', nodeId: child, at: now, kind: 'model', label: 'Response earlier/model · cached 9k · in 1k · out 20' },
            { id: 'outer', nodeId: child, at: now, kind: 'tool', label: 'Running codemode', state: 'running' },
            { id: 'inner', nodeId: child, parentEventId: 'outer', at: now + 1, kind: 'tool', label: 'Finished read · 12ms', state: 'finished' },
            { id: 'nested-model', nodeId: nested, at: now, kind: 'model', label: 'Response nested/model · usage not reported' },
            { id: 'native-total', nodeId: native, at: now, kind: 'usage', label: 'Reported run total · cached 9k · in 1k · out 20' }
        ] };
    await page.route('**/sessions/*/activity*', route => route.fulfill({ json: { available: true, live: true, serverTime: Date.now(), revision: String(revision), activity: sample } }));
    const refresh = async () => { revision++; await page.evaluate(() => window.dispatchEvent(new Event('focus'))); };
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto('http://127.0.0.1:11012/');
    await page.waitForFunction(() => currentSession && !document.querySelector('#new-session-btn').disabled);
    await page.locator('.session-row[data-session-id="session_a"] .session-link').click();
    await page.locator('#message-input').fill('Keep session tracking draft');
    const chat = await page.locator('.message').first().elementHandle();
    await page.locator('#activity-toggle').click();
    await page.locator(`[data-id="${child}"]`).waitFor();
    check((await page.locator('#activity-status').innerText()).includes('Observed Pi sessions'), 'Session view provenance missing');
    check(await page.locator('.activity-node[data-id^="async:"]').count() === 0, 'Native run/workflow/step boxes visible');
    check(await page.locator('.activity-node').count() === 3, 'Observed sessions or parent hidden');
    check(await page.locator('#activity-detail [data-edge="native-edge"]').count() === 0, 'Hidden native report remains in Connections');
    check(sample.nodes.some(node => node.id === native) && sample.events.some(row => row.id === 'native-total'), 'Source native records mutated');
    check((await page.locator(`[data-id="${child}"]`).innerText()).includes('Last response model: actual/response'), 'Actual model provenance missing');
    check((await page.locator(`[data-id="${nested}"]`).innerText()).includes('Selected model:'), 'Selected model presented as actual response');
    await page.locator('#activity-events summary').click();
    await page.locator(`[data-id="${child}"]`).click();
    check((await page.locator('#activity-detail').innerText()).includes('parent UUID and current delegation are not established'), 'Ancestry overclaimed');
    check((await page.locator('#activity-detail').innerText()).includes('historical, not current occupancy'), 'Input measurement overclaimed');
    check(await page.locator('#activity-events [data-event-id="parent-event"]').count() === 0, 'Borrowed parent history');
    check(await page.locator('#activity-events [data-event-id="native-total"]').count() === 0, 'Borrowed native totals');
    check((await page.locator('#activity-events').innerText()).includes('earlier/model'), 'Response row borrowed card model');
    check((await page.locator('#activity-events').innerText()).includes('outside the retained history'), 'Omission hidden');
    check(await page.locator('[data-event-id="outer"] > ol > [data-event-id="inner"]').count() === 1, 'Explicit child tool nesting lost');
    await page.locator('#activity-detail button').first().click();
    check((await page.locator('.activity-edge-detail').innerText()).includes('ancestry:'), 'Header link looks like delegation');
    await page.locator(`[data-id="${child}"]`).focus();
    sample.nodes[1].observation.invalidated = 'compaction'; await refresh();
    await page.waitForFunction(id => document.querySelector(`[data-id="${id}"]`).textContent.includes('Compacted'), child);
    check(await page.evaluate(() => document.activeElement.dataset.id) === child, 'Refresh stole card focus');
    check((await page.locator('#activity-detail').innerText()).includes('Last successful input'), 'Compaction deleted history');
    sample.nodes[1].observation.status = 'conflict'; sample.nodes[1].state = 'unknown'; await refresh();
    await page.waitForFunction(id => document.querySelector(`[data-id="${id}"]`).textContent.includes('conflicting observers'), child);
    sample.nodes[1].observation.status = 'stale'; await refresh();
    await page.waitForFunction(id => document.querySelector(`[data-id="${id}"]`).textContent.includes('observer stale'), child);
    sample.nodes[1].observation.status = 'closed'; sample.nodes[1].state = 'closed'; delete sample.nodes[1].observation.invalidated;
    sample.sessionTracking.limited = true; await refresh();
    await page.waitForFunction(() => document.querySelector('#activity-events').textContent.includes('does not establish native task success'));
    check((await page.locator('#activity-status').innerText()).includes('Observation limit reached'), 'Global limits hidden');
    await page.locator('[data-id="parent"]').click();
    check(await page.locator('#activity-detail [data-edge="native-edge"]').count() === 0, 'Native connection leaked after refresh');
    check(await page.locator('#activity-events [data-event-id="native-total"]').count() === 0, 'Hidden native totals borrowed by parent');
    sample.sessionTracking.available = false; await refresh();
    await page.waitForFunction(() => document.querySelector('#activity-status').textContent.includes('Session observer unavailable'));
    check(!(await page.locator('#activity-status').innerText()).includes('native status only'), 'Unavailable tracking advertises hidden reports');
    check(await page.locator('.activity-node[data-id^="async:"]').count() === 0, 'Native fallback boxes reappeared');
    sample.sessionTracking = null; await refresh();
    await page.waitForFunction(() => !document.querySelector('#activity-status').textContent.includes('Session observer unavailable'));
    check(await page.locator('.activity-node[data-id^="async:"]').count() === 0, 'Legacy/unreported tracking exposed native boxes');
    await page.setViewportSize({ width: 390, height: 844 });
    // Media-query change delivery can follow the viewport command's completion.
    await page.waitForFunction(() => document.querySelector('#activity-panel').getAttribute('role') === 'dialog');
    check(await page.locator('#activity-panel').getAttribute('role') === 'dialog', 'Phone modal missing');
    await page.locator(`[data-id="${nested}"]`).click();
    check((await page.locator('#activity-events').innerText()).includes('nested/model'), 'Nested session history absent');
    check(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), 'Phone horizontal page overflow');
    await page.locator('#activity-close').click();
    check(await page.locator('#message-input').inputValue() === 'Keep session tracking draft', 'Draft changed');
    check(await chat.evaluate(node => node.isConnected), 'Chat DOM replaced');
    check(await page.locator('#send-btn').isEnabled(), 'Tracking changed Send readiness');
    check(posts === 0, `Unexpected POSTs: ${posts}`);
    await page.unroute('**/sessions/*/activity*'); page.off('request', post);
    return { desktop: true, emulatedPhone: true, sessionOwnership: true, provenance: true, unknownAndLimits: true, posts };
}

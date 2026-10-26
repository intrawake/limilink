// Disposable --fake-chat fixture only; no real provider calls.
// Add ?controller=steady to exercise the preceding cached-page controller.
async page => {
    const base = 'http://127.0.0.1:11012';
    if (!page.url().startsWith(base + '/')) throw Error('Use the isolated fixture.');
    const check = (value, message) => { if (!value) throw Error(message); };
    const variant = await page.evaluate(() => new URL(location.href).searchParams.get('controller') || 'follow');
    if (variant === 'steady') {
        const body = await (await page.request.get(`${base}/steady.js`)).text();
        await page.route('**/follow.js', route => route.fulfill({ body, contentType: 'text/javascript' }));
        // Cached steady HTML has a header-Rename control absent in today's shell.
        const html = await (await page.request.get(page.url())).text();
        await page.route('**/?controller=steady', route => route.fulfill({ contentType: 'text/html',
            body: html.replace('</body>', '<button id="rename-current" hidden>Rename</button></body>') }));
    }
    const row = id => page.locator(`.session-row[data-session-id="${id}"]`);
    const ready = () => page.waitForFunction(() => !document.querySelector('#send-btn').disabled);
    const select = async id => { await row(id).locator('.session-link').click(); await ready(); };
    const input = page.locator('#message-input');
    const flush = () => page.evaluate(() => new Promise(requestAnimationFrame));
    const pollOffscreen = () => page.evaluate(async () => { await activeReceiptCheck?.promise; return syncBackgroundReceipt(); });
    const run = Date.now().toString(36);
    let posts = 0;
    const countPost = request => { if (request.method() === 'POST' && request.url().endsWith('/chat')) posts++; };
    page.on('request', countPost);
    await page.bringToFront();
    await page.reload();
    await page.waitForSelector('.session-row');
    await select('session_a');

    // The genuine saved reply exists while its browser POST remains unresolved.
    let oldRoute, oldResponse, oldId, arrived;
    const completed = new Promise(resolve => { arrived = resolve; });
    await page.route('**/chat', async route => {
        oldRoute = route;
        oldId = route.request().postDataJSON().request_id;
        oldResponse = await route.fetch();
        arrived();
    });
    const first = `Offscreen accepted ${run}`;
    await input.fill(first);
    await page.locator('#send-btn').click();
    await select('session_b');
    await input.fill('Keep the selected-session draft');
    const selectedHistory = await page.locator('#chat-container').textContent();
    await completed;
    await page.waitForFunction(() => !pendingSends.has('session_a')
        && !document.querySelector('.session-row[data-session-id="session_a"]').classList.contains('busy'));
    const saved = await (await page.request.get(`${base}/sessions/session_a/snapshot?request_id=${oldId}`)).json();
    check(saved.send.state === 'complete' && saved.send.outcome.status === 200, 'Server did not complete the exact Send');
    check(saved.history.at(-1).content.includes(first), 'No genuine saved reply');
    check(await input.inputValue() === 'Keep the selected-session draft', 'Offscreen completion changed the selected draft');
    check(await page.locator('#chat-container').textContent() === selectedHistory, 'Offscreen receipt replaced selected history');
    check(await input.evaluate(element => document.activeElement === element), 'Offscreen receipt moved composer focus');
    check(await page.locator('#connection-status').isHidden(), 'Offscreen recovery disconnected the selected session');

    // A late response for A1 must not clear a newer A2, even on transport failure.
    await select('session_a');
    let newerRoute, newerId, captured;
    const held = new Promise(resolve => { captured = resolve; });
    await page.route('**/chat', route => {
        newerRoute = route;
        newerId = route.request().postDataJSON().request_id;
        captured(); // Deliberately not admitted; pending is not server work.
    });
    const second = `Not yet admitted ${run}`;
    await input.fill(second);
    await page.locator('#send-btn').click();
    await held;
    await select('session_b');
    await pollOffscreen();
    check(!await row('session_a').evaluate(element => element.classList.contains('busy')), 'Unadmitted local POST still means working');
    check(await row('session_a').locator('.session-delivery').textContent() === 'Sending…', 'Pending delivery lost its separate status');
    await oldRoute.abort('failed');
    await flush();
    check(await page.evaluate(id => pendingFor('session_a').some(item => item.id === id), newerId), 'Old transport failure cleared newer Send');
    await newerRoute.abort('failed');
    await page.waitForFunction(() => !pendingSends.has('session_a') && unconfirmedSends.get('session_a')?.some(item => !item.failed));
    check(await row('session_a').locator('.session-delivery').textContent() === 'Unconfirmed', 'Missing Send was silently acknowledged');
    await page.unroute('**/chat');

    // A fetched receipt must not resurrect a saved Send dismissed during navigation.
    let heldGet, heldData, fetched;
    const receiptFetched = new Promise(resolve => { fetched = resolve; });
    await page.route('**/sessions/session_a/snapshot*', async route => {
        if (heldGet || !route.request().url().includes(`request_id=${newerId}`)) { await route.continue(); return; }
        heldGet = route;
        heldData = await (await route.fetch()).json();
        fetched();
    });
    await page.evaluate(() => { syncBackgroundReceipt(); });
    await receiptFetched;
    await select('session_a'); // Also cancels the offscreen GET.
    await page.locator('#dismiss-unconfirmed').click();
    await select('session_b');
    heldData.send = { id: newerId, state: 'complete', outcome: { status: 429, body: { detail: 'Late dismissed error' } } };
    await heldGet.fulfill({ json: heldData });
    await flush();
    check(await page.evaluate(() => !pendingSends.has('session_a') && !unconfirmedSends.has('session_a')), 'Late offscreen receipt resurrected dismissed text');
    await page.unroute('**/sessions/session_a/snapshot*');

    // Offscreen malformed, live, orphaned and failed receipts use the same rules.
    await select('session_a');
    let phase = 'running', uncertainRoute, uncertainId;
    await page.route('**/chat', route => { uncertainRoute = route; uncertainId = route.request().postDataJSON().request_id; });
    await page.route('**/sessions/session_a/snapshot*', async route => {
        const data = await (await route.fetch()).json();
        if (uncertainId && route.request().url().includes(`request_id=${uncertainId}`)) {
            data.busy = phase === 'running';
            data.busy_sessions = data.busy ? ['session_a'] : [];
            data.send = { id: uncertainId, state: phase === 'malformed' || phase === 'failed' ? 'complete' : phase };
            if (phase === 'malformed') data.send.outcome = { status: 200, body: {} };
            if (phase === 'failed') data.send.outcome = { status: 429, body: { detail: 'Fixture refusal' } };
        }
        await route.fulfill({ json: data });
    });
    const third = `Offscreen owner ${run}`;
    await input.fill(third);
    await page.locator('#send-btn').click();
    await page.waitForFunction(() => pendingFor('session_a').some(item => item.accepted));
    await select('session_b');
    phase = 'malformed';
    await pollOffscreen();
    check(await page.evaluate(() => pendingSends.has('session_a') && !unconfirmedSends.has('session_a')), 'Malformed receipt retired pending Send');
    check(await page.locator('#connection-status').isHidden() && await page.locator('#send-btn').isEnabled(), 'Malformed offscreen receipt blocked selected conversation');
    phase = 'indeterminate';
    await pollOffscreen();
    check(await page.evaluate(() => !pendingSends.has('session_a') && unconfirmedSends.get('session_a')?.some(item => !item.failed)), 'Orphaned owner lost pending text or stayed working');
    check(!await row('session_a').evaluate(element => element.classList.contains('busy')), 'Orphaned owner left working dots');
    phase = 'running'; // The same request arrives late; no browser replay.
    await pollOffscreen();
    check(await page.evaluate(() => pendingSends.has('session_a') && !unconfirmedSends.has('session_a')), 'Late live owner did not reconcile saved uncertainty');
    phase = 'failed';
    await pollOffscreen();
    check(await page.evaluate(() => !pendingSends.has('session_a') && unconfirmedSends.get('session_a')?.some(item => item.failed)), 'Known failure was not preserved');
    check(await row('session_a').locator('.session-delivery').textContent() === 'Send failed', 'Known failure mislabeled as working or uncertain');
    await uncertainRoute.fulfill({ status: 429, json: { detail: 'Fixture refusal' } });
    await page.unroute('**/chat');
    await page.unroute('**/sessions/session_a/snapshot*');
    await select('session_a');
    check((await page.locator('#unconfirmed-text').textContent()).includes(third), 'Opening failed session lost submitted text');
    await page.locator('#dismiss-unconfirmed').click();

    // Hidden pages cancel offscreen requests; selected and offscreen share one timer.
    check(await page.evaluate(() => {
        pauseUpdates();
        const paused = pollTimer === null && activeReceiptCheck === null;
        resumeUpdates();
        return paused && pollTimer !== null;
    }), 'Offscreen checks escaped the existing visibility lifecycle');
    check(posts === 3, `Unexpected POST count: ${posts}; only three explicit Sends were made`);
    page.off('request', countPost);
    if (variant === 'steady') {
        await page.unroute('**/follow.js');
        await page.unroute('**/?controller=steady');
    }
    return { passed: true, controller: variant, browserPosts: posts, providers: 0,
        cases: ['saved offscreen reply clears stuck POST', 'no selected draft/history/focus mutation', 'late transport failure preserves newer Send',
            'unadmitted POST is not working', 'missing Send remains uncertain', 'cancelled/dismissed receipt stays dismissed',
            'malformed receipt retained', 'orphan and late live owner reconciled', 'known failure preserved', 'shared polling lifecycle'] };
}

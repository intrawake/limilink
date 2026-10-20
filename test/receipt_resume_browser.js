// Requires the disposable --fake-chat fixture, never a provider.
async page => {
    const base = 'http://127.0.0.1:11012';
    if (!page.url().startsWith(base + '/')) throw new Error('Use the isolated fixture.');
    const check = (value, message) => { if (!value) throw new Error(message); };
    const ready = () => page.waitForFunction(() => !document.querySelector('#send-btn').disabled);
    const warning = page.locator('#unconfirmed-send');
    const input = page.locator('#message-input');
    const run = await page.evaluate(() => Date.now().toString(36));
    const reset = async () => {
        await page.reload();
        await page.waitForSelector('.session-row');
        await page.locator('.session-row[data-session-id="session_a"] .session-link').click();
        await ready();
    };
    const resume = () => page.evaluate(() => {
        Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
        document.dispatchEvent(new Event('visibilitychange'));
        Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' });
        document.dispatchEvent(new Event('visibilitychange'));
    });
    let posts = 0;
    const count = request => { if (request.method() === 'POST' && request.url().endsWith('/chat')) posts++; };
    page.on('request', count);
    await reset();

    // Genuine accepted work, followed by a genuine browser transport failure.
    await page.evaluate(() => {
        window.receiptWarningSeen = false;
        new MutationObserver(() => {
            if (!document.querySelector('#unconfirmed-send').hidden) window.receiptWarningSeen = true;
        }).observe(document.querySelector('#unconfirmed-send'), { attributes: true, attributeFilter: ['hidden'] });
    });
    let acceptedRoute, acceptedBody, done, seen;
    const captured = new Promise(resolve => { seen = resolve; });
    const completed = new Promise(resolve => { done = resolve; });
    await page.route('**/chat', async route => {
        acceptedRoute = route;
        acceptedBody = route.request().postDataJSON();
        seen();
        await route.fetch();
        done();
    });
    await input.fill(`Quiet accepted resume ${run}`);
    await page.locator('#send-btn').click();
    await captured;
    await page.waitForFunction(async id => {
        const data = await (await fetch(`/sessions/session_a/snapshot?request_id=${id}`)).json();
        return data.send?.state === 'running';
    }, acceptedBody.request_id);
    await input.fill('Keep my newer draft');
    await resume();
    await page.waitForFunction(() => document.querySelector('#typing').textContent === 'Thinking…' && document.querySelector('#connection-status').hidden);
    check(await warning.isHidden(), 'Live accepted Send incorrectly warned on resume');
    await acceptedRoute.abort('failed');
    await completed;
    await ready();
    check(await warning.isHidden(), 'Completed accepted Send incorrectly warned after transport loss');
    check(await page.evaluate(() => !window.receiptWarningSeen), 'Accepted Send flashed a transient uncertainty warning');
    check(await input.inputValue() === 'Keep my newer draft', 'Receipt reconciliation changed the newer draft');
    await page.unroute('**/chat');

    // A permanently missing A must not starve receipt discovery for a later B.
    await reset();
    const missing = `Permanently missing ${run}`;
    const later = `Later accepted ${run}`;
    const held = [];
    await page.route('**/chat', route => { held.push(route); });
    for (const text of [missing, later]) {
        await input.fill(text);
        await page.locator('#send-btn').click();
        await page.waitForFunction(() => document.querySelector('#send-btn').disabled);
        await resume();
        await ready();
        check((await page.locator('#unconfirmed-text').textContent()).includes(text), 'Actually missing Send was not preserved');
    }
    check(held.length === 2, 'Resume silently posted another Send');
    const laterResponse = await held[1].fetch(); // First admitted now; browser reply remains held.
    await page.waitForFunction(text => !document.querySelector('#unconfirmed-text').textContent.includes(text) && !document.querySelector('#send-btn').disabled, later, { timeout: 15000 });
    check((await page.locator('#unconfirmed-text').textContent()).includes(missing), 'Unresolved older Send text was discarded');
    await held[0].abort('failed');
    await held[1].fulfill({ response: laterResponse });
    await page.unroute('**/chat');

    // A receipt GET already in flight cannot resurrect text the human dismissed.
    let dismissedGet, dismissedData, gotDismissed;
    const checkingDismissed = new Promise(resolve => { gotDismissed = resolve; });
    const dismissedId = held[0].request().postDataJSON().request_id;
    await page.route('**/sessions/session_a/snapshot*', async route => {
        if (!route.request().url().includes(`request_id=${dismissedId}`)) { await route.continue(); return; }
        dismissedGet = route;
        dismissedData = await (await route.fetch()).json();
        gotDismissed();
    });
    await page.evaluate(() => { syncSnapshot({ force: true }); });
    await checkingDismissed;
    await page.locator('#dismiss-unconfirmed').click();
    dismissedData.send = { id: dismissedId, state: 'complete', outcome: { status: 429, body: { detail: 'Late dismissed failure' } } };
    await dismissedGet.fulfill({ json: dismissedData });
    await page.evaluate(() => new Promise(requestAnimationFrame));
    check(await warning.isHidden(), 'Late receipt resurrected a dismissed saved message');
    check(await page.locator('#send-btn').isEnabled(), 'Late dismissed receipt reinserted a pending request');
    await page.unroute('**/sessions/session_a/snapshot*');

    // A visible page must detect an orphan without a visibility/focus event.
    await reset();
    let phase = 'running', orphanRoute, orphanId;
    await page.route('**/chat', route => { orphanRoute = route; orphanId = route.request().postDataJSON().request_id; });
    await page.route('**/sessions/session_a/snapshot*', async route => {
        const data = await (await route.fetch()).json();
        if (data.send?.id === orphanId) {
            data.send = { id: orphanId, state: phase };
            data.busy = phase === 'running';
            data.busy_sessions = data.busy ? ['session_a'] : [];
        }
        await route.fulfill({ json: data });
    });
    await input.fill(`Visible owner disappears ${run}`);
    await page.locator('#send-btn').click();
    await page.waitForFunction(() => document.querySelector('#typing').textContent === 'Thinking…');
    check(await warning.isHidden(), 'Matching live owner was called uncertain');
    phase = 'indeterminate'; // Only ordinary polling sees this transition.
    await page.waitForFunction(() => !document.querySelector('#unconfirmed-send').hidden && !document.querySelector('#send-btn').disabled);
    check((await page.locator('#unconfirmed-text').textContent()).includes('Visible owner disappears'), 'Orphaned Send remained stuck or lost its text');
    await orphanRoute.abort('failed');
    await page.unroute('**/chat');
    await page.unroute('**/sessions/session_a/snapshot*');

    // A malformed receipt cannot retire the request; known errors save text as failed.
    await reset();
    let invalid = true, errorRoute, errorId;
    await page.route('**/chat', route => { errorRoute = route; errorId = route.request().postDataJSON().request_id; });
    await page.route('**/sessions/session_a/snapshot*', async route => {
        const data = await (await route.fetch()).json();
        if (data.send?.id === errorId) data.send = { id: errorId, state: 'complete', outcome: invalid
            ? { status: 200, body: {} }
            : { status: 429, body: { detail: 'Fixture refusal' } } };
        await route.fulfill({ json: data });
    });
    const failedText = `Preserve known failure ${run}`;
    await input.fill(failedText);
    await page.locator('#send-btn').click();
    await page.waitForFunction(() => document.querySelector('#connection-status').textContent.includes('Connection lost'));
    check(await warning.isHidden(), 'Malformed complete receipt caused a false acknowledgement/warning');
    check(await page.locator('#send-btn').isDisabled(), 'Malformed complete receipt cleared pending state');
    await input.fill('New draft stays');
    invalid = false;
    await ready();
    check((await page.locator('#saved-send-status').textContent()).includes('send failed'), 'Known error was mislabeled as possibly lost');
    check((await page.locator('#unconfirmed-text').textContent()).includes(failedText), 'Known failure discarded submitted text');
    await errorRoute.fulfill({ status: 429, json: { detail: 'Fixture refusal' } });
    await page.evaluate(() => new Promise(requestAnimationFrame));
    check((await page.locator('#unconfirmed-text').textContent()).includes(failedText), 'Late HTTP error cleared saved failed text');
    await page.locator('#restore-unconfirmed').click();
    check(await input.inputValue() === `New draft stays\n\n${failedText}`, 'Restoring failed text overwrote the newer draft');
    await page.unroute('**/chat');
    await page.unroute('**/sessions/session_a/snapshot*');
    page.off('request', count);
    check(posts === 5, `Unexpected automatic POST: ${posts} instead of five explicit Sends`);
    return { passed: true, cases: ['quiet live/completed receipt despite transport failure', 'no transient false warning', 'fair saved-receipt polling', 'dismissal wins over late receipt', 'ordinary-poll orphan detection', 'malformed receipt retained', 'known failure text retained across late HTTP error'], browserPosts: posts, providers: 0 };
}

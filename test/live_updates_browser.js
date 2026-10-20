// Requires: tool/sidebar_preview.py --fake-chat. Only localhost fixture data.
async page => {
    if (!page.url().startsWith('http://127.0.0.1:11012/')) throw new Error('Use the isolated fixture server.');
    const base = 'http://127.0.0.1:11012';
    const run = await page.evaluate(() => Date.now().toString(36));
    const check = (value, message) => { if (!value) throw new Error(message); };
    const input = page.locator('#message-input');
    const send = page.locator('#send-btn');
    const chat = page.locator('#chat-container');
    const row = id => page.locator(`.session-row[data-session-id="${id}"]`);
    const flush = () => page.evaluate(() => new Promise(requestAnimationFrame));
    const ready = () => page.waitForFunction(() => !document.querySelector('#send-btn').disabled);
    const setVisibility = state => page.evaluate(value => {
        Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => value });
        document.dispatchEvent(new Event('visibilitychange'));
    }, state);
    let snapshots = 0;
    const countSnapshot = request => { if (request.url().includes('/snapshot')) snapshots++; };
    page.on('request', countSnapshot);
    await page.bringToFront();
    await page.reload();
    await page.waitForSelector('.session-row');
    await row('session_a').locator('.session-link').click();
    await ready();

    // A second client's activity must appear even with no local send promise.
    const external = page.request.post(`${base}/chat`, { data: { session_id: 'session_a', message: 'External typing check' } });
    await page.waitForFunction(() => !document.querySelector('#typing').hidden && document.querySelector('#typing').textContent === 'Thinking…');
    check(send && await send.isDisabled(), 'Server busy did not disable duplicate sends');
    check((await external).ok(), 'Fake external chat failed');
    await page.waitForFunction(() => document.querySelector('#chat-container').textContent.includes('Fixture reply: External typing check') && document.querySelector('#typing').hidden);
    await ready();

    // Same revision, changed busy: update typing without replacing messages.
    const canonical = await (await page.request.get(`${base}/sessions/session_a/snapshot`)).json();
    let fakeBusy = true;
    await page.locator('.message').first().evaluate(element => element.dataset.keptNode = 'yes');
    await page.route('**/sessions/session_a/snapshot*', route => route.fulfill({ json: {
        session_id: 'session_a', revision: canonical.revision, busy: fakeBusy,
        busy_sessions: fakeBusy ? ['session_a'] : [],
    } }));
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await page.waitForFunction(() => !document.querySelector('#typing').hidden);
    fakeBusy = false;
    await page.waitForFunction(() => document.querySelector('#typing').hidden);
    check(await page.locator('.message').first().getAttribute('data-kept-node') === 'yes', 'Unchanged revision replaced the conversation DOM');
    await page.unroute('**/sessions/session_a/snapshot*');
    await ready();

    async function lostResponseScenario(suffix, lateFailure) {
        const firstText = `Lost response ${suffix} ${run}`;
        const secondText = `Newer send ${suffix} ${run}`;
        let firstRoute, firstResponse, secondRoute, firstDone, secondSeen;
        const completed = new Promise(resolve => { firstDone = resolve; });
        const secondCaptured = new Promise(resolve => { secondSeen = resolve; });
        await page.route('**/chat', async route => {
            const message = route.request().postDataJSON().message;
            if (message === firstText) {
                firstRoute = route;
                firstResponse = await route.fetch(); // Real server work finishes; browser POST stays pending.
                firstDone();
            } else if (message === secondText) {
                secondRoute = route; // Not admitted yet: idle snapshots must not clear this send.
                secondSeen();
            } else await route.continue();
        });
        await input.fill(firstText);
        await send.click();
        await page.waitForFunction(() => document.querySelector('#typing').textContent === 'Thinking…');
        await input.fill(`Draft kept across resume ${suffix}`);
        await setVisibility('hidden');
        const hiddenCount = snapshots;
        await completed;
        await page.waitForTimeout(2200);
        check(snapshots === hiddenCount, 'Hidden page kept polling');
        await setVisibility('visible');
        await page.waitForFunction(text => document.querySelector('#chat-container').textContent.includes(`Fixture reply: ${text}`) && !document.querySelector('#send-btn').disabled, firstText);
        check(await page.locator('#typing').isHidden(), 'Recovered server-idle state stayed typing');
        check(await input.inputValue() === `Draft kept across resume ${suffix}`, 'Recovery overwrote a newer draft');
        check(await page.locator('#unconfirmed-send').isHidden(), 'Completed Send receipt was incorrectly called uncertain');
        await input.fill(secondText);
        await send.click();
        await secondCaptured;
        await page.waitForTimeout(2200); // Ordinary snapshots observe idle before POST admission.
        check(await send.isDisabled(), 'Idle snapshot falsely acknowledged a not-yet-admitted send');
        check((await chat.textContent()).includes(secondText), 'Pre-admission snapshot erased the optimistic message');
        if (lateFailure) await firstRoute.fulfill({ status: 500, json: { detail: 'Stale request failure' } });
        else await firstRoute.fulfill({ response: firstResponse });
        await flush();
        check(await send.isDisabled(), 'Old POST continuation cleared a newer pending send');
        check(!(await page.locator('#notice').textContent()).includes('Stale request failure'), 'Old POST error polluted newer UI');
        check(await page.locator('#unconfirmed-send').isHidden(), 'Old POST resurrected a dismissed recovery notice');
        const secondResponse = await secondRoute.fetch();
        await secondRoute.fulfill({ response: secondResponse });
        await page.waitForFunction(text => document.querySelector('#chat-container').textContent.includes(`Fixture reply: ${text}`) && !document.querySelector('#send-btn').disabled, secondText);
        const messages = await page.locator('.message').allTextContents();
        check(messages.filter(text => text === secondText).length === 1, 'Newer user message duplicated');
        check(messages.filter(text => text === `Fixture reply: ${secondText}`).length === 1, 'Newer reply duplicated');
        await page.unroute('**/chat');
    }
    await lostResponseScenario('success', false);
    await lostResponseScenario('failure', true);

    // A real browser transport disconnect must not cancel the accepted server work.
    const disconnectedText = `Transport disconnected ${run}`;
    await page.evaluate(text => {
        const controller = new AbortController();
        window.transportAbort = controller;
        fetch('/chat', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ session_id: 'session_a', message: text }),
            signal: controller.signal,
        }).catch(() => {});
    }, disconnectedText);
    await page.waitForFunction(() => !document.querySelector('#typing').hidden && document.querySelector('#typing').textContent === 'Thinking…');
    await page.evaluate(() => window.transportAbort.abort());
    await page.waitForFunction(text => document.querySelector('#chat-container').textContent.includes(`Fixture reply: ${text}`) && document.querySelector('#typing').hidden, disconnectedText);
    await ready();

    // An obsolete/hanging GET must not block a new foreground sync.
    let blocked, observed;
    const seen = new Promise(resolve => { observed = resolve; });
    let blockOnce = true;
    await page.route('**/sessions/session_a/snapshot*', route => {
        if (blockOnce) { blockOnce = false; blocked = route; observed(); }
        else route.continue();
    });
    await page.evaluate(() => { syncSnapshot({ force: true }); });
    await seen;
    await setVisibility('hidden');
    await setVisibility('visible');
    await ready();
    await blocked.fulfill({ json: { revision: 'obsolete', busy: true, busy_sessions: ['session_a'], history: [{ role: 'bot', content: 'Obsolete snapshot must not render' }] } });
    await flush();
    check(!(await chat.textContent()).includes('Obsolete snapshot'), 'Late GET rolled history backward');
    check(await send.isEnabled(), 'Late GET changed recovered busy state');
    await page.unroute('**/sessions/session_a/snapshot*');

    // HTTP rejection is a known failure, not an accepted optimistic message.
    await page.route('**/chat', route => route.fulfill({ status: 409, json: { detail: 'Test rejection' } }));
    let rejectSnapshot = true;
    await page.route('**/sessions/session_a/snapshot*', route => rejectSnapshot ? route.fulfill({ status: 500, json: { detail: 'Temporary snapshot failure' } }) : route.continue());
    await input.fill('Rejected message must not remain in history');
    await send.click();
    await page.waitForFunction(() => document.querySelector('#connection-status').textContent.includes('Connection lost'));
    rejectSnapshot = false;
    await page.evaluate(() => window.dispatchEvent(new Event('online')));
    await ready();
    check(!(await chat.textContent()).includes('Rejected message must not remain'), 'Rejected optimistic bubble remained as if accepted');
    check((await page.locator('#notice').textContent()).includes('Test rejection'), 'Known rejection was hidden');
    check((await page.locator('#saved-send-status').textContent()).includes('send failed'), 'Known rejection was mislabeled as uncertainty');
    check((await page.locator('#unconfirmed-text').textContent()).includes('Rejected message must not remain'), 'Known rejection discarded submitted text');
    await page.locator('#dismiss-unconfirmed').click();
    await page.unroute('**/chat');
    await page.unroute('**/sessions/session_a/snapshot*');

    // Keep history, scroll, draft, and focus through offline errors and new replies.
    const longText = Array.from({ length: 45 }, (_, index) => `Line ${index}: enough history to scroll without losing position.`).join('\n');
    check((await page.request.post(`${base}/chat`, { data: { session_id: 'session_a', message: longText } })).ok(), 'Long fixture message failed');
    await page.evaluate(() => window.dispatchEvent(new Event('pageshow')));
    await page.waitForFunction(() => document.querySelector('#chat-container').textContent.includes('Fixture reply: Line 0:') && document.querySelector('#chat-container').scrollHeight > document.querySelector('#chat-container').clientHeight * 2);
    await ready();
    await input.fill('Draft while reading older messages');
    await chat.evaluate(element => element.scrollTop = 120);
    await flush();
    const before = await chat.textContent();
    const top = await chat.evaluate(element => element.scrollTop);
    await page.context().setOffline(true);
    await page.waitForFunction(() => document.querySelector('#connection-status').textContent.includes('Connection lost'));
    check(await chat.textContent() === before, 'Offline status cleared the conversation');
    check(Math.abs(await chat.evaluate(element => element.scrollTop) - top) <= 1, 'Offline error moved the reading position');
    check(await input.inputValue() === 'Draft while reading older messages', 'Offline error lost the draft');
    await page.context().setOffline(false);
    await ready();
    const appended = page.request.post(`${base}/chat`, { data: { session_id: 'session_a', message: 'Reply while scrolled up' } });
    check((await appended).ok(), 'Scrolled fixture message failed');
    await page.waitForFunction(() => document.querySelector('#chat-container').textContent.includes('Fixture reply: Reply while scrolled up'));
    check(Math.abs(await chat.evaluate(element => element.scrollTop) - top) <= 1, 'Incoming reply jumped to the bottom');
    check(await input.inputValue() === 'Draft while reading older messages', 'Incoming reply changed the draft');
    check(await input.evaluate(element => document.activeElement === element), 'Incoming reply stole focus');

    // Saved uncertain text is restored only on request and never replaces a draft.
    await page.route('**/chat', route => route.abort('failed'));
    await input.fill('Delivery uncertainty fixture');
    await send.click();
    await page.waitForFunction(() => !document.querySelector('#unconfirmed-send').hidden);
    await page.unroute('**/chat');
    await input.fill('New draft must survive');
    await page.locator('#restore-unconfirmed').click();
    check(await input.inputValue() === 'New draft must survive\n\nDelivery uncertainty fixture', 'Restoring uncertain text overwrote the newer draft');

    // Real renderer freeze/resume: no manual page reload, no synthetic wake event.
    await page.evaluate(() => { delete document.visibilityState; window.liveUpdateMarker = 'still-the-same-page'; });
    await page.bringToFront();
    await ready();
    const cdp = await page.context().newCDPSession(page);
    try {
        await cdp.send('Page.setWebLifecycleState', { state: 'frozen' });
        check((await page.request.post(`${base}/chat`, { data: { session_id: 'session_a', message: 'Frozen page delivery' } })).ok(), 'Frozen fixture message failed');
    } finally {
        await cdp.send('Page.setWebLifecycleState', { state: 'active' });
        await cdp.detach();
    }
    await page.waitForFunction(() => document.querySelector('#chat-container').textContent.includes('Fixture reply: Frozen page delivery'));
    check(await page.evaluate(() => window.liveUpdateMarker) === 'still-the-same-page', 'Recovery required a page reload');
    page.off('request', countSnapshot);
    console.log('PASS: cross-client typing, unchanged-revision busy state, hidden polling pause, lost POST recovery, stale success/error isolation, hanging GET recovery, offline preservation, scroll/draft/focus, actual renderer freeze/resume. No model calls.');
}

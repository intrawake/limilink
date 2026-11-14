// Disposable preview only. Offscreen operation GETs never replace selected history.
async page => {
    const base = 'http://127.0.0.1:11012';
    if (!page.url().startsWith(base + '/')) throw Error('Use the isolated fixture.');
    const check = (value, message) => { if (!value) throw Error(message); };
    let post, held, seen;
    const captured = new Promise(resolve => { seen = resolve; });
    let operation = null, malformed = false;
    const input = page.locator('#message-input');
    const row = id => page.locator(`.session-row[data-session-id="${id}"]`);
    const select = async id => {
        await row(id).locator('.session-link').click();
        await page.waitForFunction(id => currentSession === id && historyReady, id);
    };
    let posts = 0;
    await page.route('**/sessions/*/operations*', async route => {
        if (route.request().method() === 'POST') { held = route; post = route.request().postDataJSON(); posts++; seen(); }
        else {
            const id = route.request().url().split('?')[0].split('/').at(-2);
            await route.fulfill({ json: { operations: id === 'session_a' && operation ? [{ ...operation,
                ...(malformed ? { state: 'succeeded', revision: 50, outcome: { status: 200, body: {} } } : {}) }] : [] } });
        }
    });
    try {
        await page.setViewportSize({ width: 1280, height: 900 }); await page.bringToFront();
        await page.evaluate(() => { localStorage.clear(); localStorage.setItem('limilink_last_session', 'session_a'); });
        await page.reload(); await select('session_a');
        await input.fill('Offscreen work'); await page.locator('#send-btn').click(); await captured;
        operation = { id: post.request_id, session_id: 'session_a', sequence: 0, revision: 0, state: 'queued', message: post.message, execution_id: null, outcome: null };
        await held.fulfill({ status: 202, json: { operation } });
        await page.waitForFunction(() => document.querySelector('#typing').textContent === 'Queued');
        await select('session_b'); await input.fill('Keep B draft');
        const history = await page.locator('#chat-container').textContent();
        const poll = () => page.evaluate(() => syncBackgroundOperations());
        operation = { ...operation, state: 'running', revision: 1 };
        await poll();
        check(await row('session_a').locator('.session-delivery').textContent() === 'Running', 'Offscreen running state not reconciled');
        malformed = true; await poll(); malformed = false;
        check(await row('session_a').locator('.session-delivery').textContent() === 'Running', 'Malformed outcome retired known running work');
        operation = { ...operation, state: 'indeterminate', revision: 2 };
        await poll();
        check(await row('session_a').locator('.session-delivery').textContent() === 'Effects unknown', 'Effects uncertainty hidden');
        operation = { ...operation, state: 'failed', revision: 3, outcome: { status: 500, body: { detail: 'Fixture failure' } } };
        await poll();
        check(await row('session_a').locator('.session-delivery').textContent() === 'Send failed', 'Known failure mislabeled');
        check(await input.inputValue() === 'Keep B draft', 'Offscreen state changed B draft');
        check(await page.locator('#chat-container').textContent() === history, 'Offscreen state replaced B history');
        check(await input.evaluate(node => document.activeElement === node), 'Offscreen state moved focus');
        check(await page.locator('#connection-status').isHidden(), 'Offscreen state disconnected selected view');
        await select('session_a');
        check(await page.locator('#unconfirmed-text').textContent() === post.message, 'Failed text lost on navigation');
        await page.locator('#dismiss-unconfirmed').click();
        operation = { ...operation, revision: 4 }; await page.evaluate(() => syncOperations());
        check(await page.locator('#unconfirmed-send').isHidden(), 'Late state resurrected dismissed text');
        check(posts === 1, 'Offscreen recovery posted again');
        check(await page.evaluate(() => { pauseUpdates(); return pollTimer === null && operationChecks.size === 0; }), 'Polling escaped visibility lifecycle');
        return { passed: true, posts, providers: 0, cases: ['offscreen queued/running/indeterminate/failed', 'malformed result retained', 'selected history/draft/focus unchanged', 'dismissal wins', 'one polling lifecycle'] };
    } finally {
        await page.evaluate(() => pauseUpdates()).catch(() => {});
        try { await held?.abort('failed'); } catch {}
        await page.unroute('**/sessions/*/operations*');
    }
}

// Disposable preview only. Admission is authoritative, not snapshot readiness.
async page => {
    const base = 'http://127.0.0.1:11012';
    if (!page.url().startsWith(base + '/')) throw Error('Use the isolated fixture.');
    const check = (value, message) => { if (!value) throw Error(message); };
    const reads = [], held = [], posts = [];
    let wake;
    const arrival = count => posts.length >= count ? Promise.resolve() : new Promise(resolve => { wake = { count, resolve }; });
    const input = page.locator('#message-input'), button = page.locator('#send-btn');
    await page.route('**/sessions/session_a/snapshot*', route => { reads.push(route); });
    await page.route('**/sessions/*/operations*', async route => {
        if (route.request().method() === 'POST') {
            held.push(route); posts.push(route.request().postDataJSON());
            if (wake && posts.length >= wake.count) { wake.resolve(); wake = null; }
        } else await route.fulfill({ json: { operations: [] } });
    });
    try {
        await page.setViewportSize({ width: 1280, height: 900 }); await page.bringToFront();
        await page.evaluate(() => { localStorage.clear(); localStorage.setItem('limilink_last_session', 'session_a'); });
        await page.reload();
        await page.waitForFunction(() => currentSession === 'session_a' && checkingSnapshot && !historyReady);
        check(await button.isEnabled() && await input.isEnabled(), 'Initial history disabled action/composer');
        await input.fill('Enter during history loading'); await input.press('Enter'); await arrival(1);
        await page.evaluate(() => {
            connected=false; historyReady=false; checkingSnapshot=true;
            sessions.find(item => item.id === currentSession).delete_at=Date.now()/1000+60;
            serverBusy.add(currentSession); updateInputState();
        });
        await input.fill('Staged despite stale read'); await input.press('Enter');
        check(posts.length === 1, 'Staged request bypassed earlier admission');
        check(await button.isEnabled() && await input.isEnabled(), 'Stale state disabled action');
        await held[0].fulfill({ status: 409, json: { detail: 'Conversation is trashed' } }); await arrival(2);
        await input.fill('Keep newer draft');
        await held[1].fulfill({ status: 429, json: { detail: 'Server queue full' } });
        await page.waitForFunction(() => document.querySelector('#unconfirmed-text').textContent.includes('Staged despite stale read'));
        check(await input.inputValue() === 'Keep newer draft', 'Refusal overwrote newer typing');
        check((await page.locator('#notice').textContent()).includes('Not accepted'), 'Known refusal not explicit');
        await page.locator('#restore-unconfirmed').click();
        check(await input.inputValue() === 'Keep newer draft\n\nEnter during history loading\n\nStaged despite stale read', 'Restore lost text or overwrote draft');
        check(posts.length === 2, 'Restore automatically resent');
        // A bounded timeout/lost transport is uncertain, not a safe failure.
        await input.fill('Unknown transport'); await input.press('Enter'); await arrival(3);
        await input.fill('Keep unknown draft'); await held[2].abort('failed');
        await page.waitForFunction(() => document.querySelector('#saved-send-status').textContent.includes('unknown'));
        check(await button.isEnabled(), 'Uncertainty disabled Send action');
        check(await input.inputValue() === 'Keep unknown draft', 'Uncertainty lost draft');
        await input.press('Enter');
        check(posts.length === 3 && await input.inputValue() === 'Keep unknown draft', 'Unknown acceptance silently bypassed or lost draft');
        await input.fill('!stop'); await input.press('Enter'); await arrival(4);
        check(posts[3].message === '!stop', 'Unknown acceptance prevented explicit stop');
        await held[3].fulfill({ status: 409, json: { detail: 'Fixture stop refusal' } });
        return { passed: true, posts: 4, providers: 0, cases: ['initial Enter despite pending history', 'stale trash/busy never gates', 'visible ordered staging', 'known refusal/draft retention', 'explicit restore does not send', 'unknown acceptance retains text', 'stop remains available'] };
    } finally {
        await page.evaluate(() => pauseUpdates()).catch(() => {});
        for (const route of [...held, ...reads]) { try { await route.abort('failed'); } catch {} }
        await page.unroute('**/sessions/*/operations*');
        await page.unroute('**/sessions/session_a/snapshot*');
    }
}

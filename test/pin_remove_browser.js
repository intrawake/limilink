// Disposable tool/delivery_fixture.py on 11018 only. No provider calls.
async page => {
    const base = 'http://127.0.0.1:11018';
    if (!page.url().startsWith(base + '/')) throw Error('Use disposable fixture');
    const check = (value, message) => { if (!value) throw Error(message); };
    const ids = ['a'.repeat(32), 'b'.repeat(32)];
    for (const id of ids) {
        const status = await page.evaluate(async id => {
            const png = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQImWP4z8DwHwAFgAI/ScLttAAAAABJRU5ErkJggg=='), c => c.charCodeAt(0));
            return (await fetch(`/sessions/session_a/media/${id}?filename=pin-${id[0]}.png`, {method:'PUT',body:png})).status;
        }, id);
        check(status === 201, 'Fixture pin upload failed');
    }
    await page.setViewportSize({width:1440,height:900});
    await page.evaluate(() => localStorage.setItem('limilink_last_session','session_a'));
    await page.reload();
    await page.waitForFunction(() => historyReady && currentSession === 'session_a' && sessionMediaShelf.cards.size === 2);
    await page.evaluate(() => {
        pauseUpdates(); operations.clear(); serverBusy.clear();
        ownOperation('session_a', {id:'c'.repeat(32),text:'fixture',state:'running'});
        renderSessions();
    });
    const row = page.locator('.session-row[data-session-id="session_a"]');
    check(await row.locator('.session-working').textContent() === '⏳', 'Running lost hourglass');
    check(await row.locator('.session-working').getAttribute('aria-label') === 'Working', 'Hourglass lost accessible label');
    check(await row.locator('.session-delivery').count() === 0, 'Redundant Running label remains');
    await page.evaluate(() => {
        trackedFor('session_a')[0].state='unknown';renderSessions();
    });
    check(await row.locator('.session-delivery').textContent() === 'Acceptance unknown', 'Uncertainty status was hidden');
    await page.locator('#message-input').fill('keep my draft');
    await page.locator('#media-toggle').click();
    const first = page.getByRole('button', {name:'Remove pin pin-a.png',exact:true});
    await page.evaluate(() => { window.confirm = message => { window.pinConfirmation = message; return false; }; });
    await first.click();
    check(await first.isVisible(), 'Cancelled removal hid pin');
    check((await page.request.get(`${base}/sessions/session_a/media/${ids[0]}`)).status() === 200, 'Cancel deleted pin');
    await first.focus();
    check(await page.evaluate(() => window.pinConfirmation.includes('original source file is not deleted')), 'Confirmation lost source-file distinction');
    await page.evaluate(() => { window.confirm = () => true; });
    await first.click();
    await page.waitForFunction(() => sessionMediaShelf.cards.size === 1);
    check(await page.locator('#media-toggle').textContent() === 'Pins (1)', 'Pin count not updated');
    check(await page.evaluate(() => document.activeElement.id === 'media-close'), 'Removal lost keyboard focus');
    check((await page.request.get(`${base}/sessions/session_a/media/${ids[0]}/content`)).status() === 404, 'Removed content still accessible');
    check((await page.request.get(`${base}/sessions/session_a/media/${ids[1]}/content`)).status() === 200, 'Other pin deleted');
    check(await page.locator('#message-input').inputValue() === 'keep my draft', 'Removal disturbed the draft');
    await page.reload();
    await page.waitForFunction(() => historyReady && sessionMediaShelf.cards.size === 1);
    await page.locator('#message-input').fill('draft survives removing pins');
    await page.setViewportSize({width:320,height:844});
    await page.locator('#media-toggle').click();
    check(await page.locator('#session-media').getAttribute('aria-modal') === 'true', 'Mobile pins not modal');
    check(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'Mobile overflow');
    const last = page.getByRole('button', {name:'Remove pin pin-b.png',exact:true});
    await last.focus();
    await page.keyboard.press('Tab');
    check(await page.evaluate(() => document.activeElement.id === 'media-close'), 'Focus trap excluded Remove');
    await page.evaluate(() => { window.confirm = () => true; });
    await last.click();
    await page.waitForFunction(() => sessionMediaShelf.cards.size === 0);
    check(await page.locator('#media-status').textContent() === 'No pins yet.', 'Empty shelf status missing');
    await page.locator('#media-close').click();
    check(await page.locator('#message-input').inputValue() === 'draft survives removing pins', 'Mobile removal disturbed draft');
    check(!await page.locator('#send-btn').isDisabled(), 'Pin removal disabled Send');
    return {passed:true,checks:['hourglass without Running; other labels preserved','cancel/confirm','server copy removed; other pin preserved','count/reload/empty shelf','desktop keyboard focus','320px focus trap and layout','Send remains available']};
}

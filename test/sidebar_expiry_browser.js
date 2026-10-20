// One real 60-second expiry check, only on the isolated localhost fixture server.
async page => {
    if (!page.url().startsWith('http://127.0.0.1:11012/')) throw new Error('Use the isolated fixture server.');
    const check = (condition, message) => { if (!condition) throw new Error(message); };
    const base = 'http://127.0.0.1:11012';
    const created = await page.request.post(`${base}/sessions`);
    check(created.ok(), 'Fixture creation failed');
    const id = (await created.json()).session_id;
    await page.reload();
    await page.waitForFunction(() => !document.querySelector('#new-session-btn').disabled);
    const row = page.locator(`.session-row[data-session-id="${id}"]`);
    await row.locator('.trash-button').click();
    await page.waitForFunction(() => !document.querySelector('#new-session-btn').disabled);
    const deadline = Number(await row.locator('.trash-countdown').getAttribute('data-delete-at'));
    const replay = await page.request.post(`${base}/sessions/${id}/trash`);
    check(replay.ok(), 'Trash replay failed');
    check((await replay.json()).sessions.find(session => session.id === id).delete_at === deadline, 'Repeated trash extended the deadline');
    await page.reload();
    await page.waitForFunction(() => !document.querySelector('#new-session-btn').disabled);
    check(await row.count() === 1, 'Reload prematurely removed the session');
    await page.waitForFunction(target => ![...document.querySelectorAll('.session-row')].some(row => row.dataset.sessionId === target), id, { timeout: 75000 });
    const listing = await (await page.request.get(`${base}/sessions`)).json();
    check(!listing.sessions.includes(id), 'UI hid the row but server did not remove the directory');
    const late = await page.request.post(`${base}/chat`, { data: { session_id: id, message: '!agent' } });
    check(late.status() === 409, 'A stale command recreated the deleted session');
    check((await page.request.delete(`${base}/sessions/${id}/trash`)).status() === 410, 'Expired Undo unexpectedly succeeded');
    console.log('PASS: real server-side 60s expiry, browser reload/replay preserve deadline, row/directory removed, stale work cannot resurrect. No model calls.');
}

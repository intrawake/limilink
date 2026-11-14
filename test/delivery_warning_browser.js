// Disposable tool/delivery_fixture.py --hold-prior session_b only.
// A real separate process owns the session fence; Stop must not hide its failure.
async page => {
    const base = 'http://127.0.0.1:11018';
    if (!page.url().startsWith(base + '/')) throw Error('Use the disposable delivery fixture.');
    const check = (value, message) => { if (!value) throw Error(message); };
    await page.evaluate(() => { localStorage.clear(); localStorage.setItem('limilink_last_session','session_b'); });
    await page.reload();
    await page.waitForFunction(() => document.querySelector('#session-directory').textContent === 'session_b');
    const before = await (await page.request.get(base+'/sessions/session_b/history')).json();
    await page.locator('#message-input').fill('!stop');
    await page.locator('#send-btn').click();
    await page.locator('#unconfirmed-send').waitFor({state:'visible'});
    check((await page.locator('#saved-send-status').textContent()).includes('earlier writer'), 'Stop failed without a visible surviving-writer warning');
    check((await page.locator('#saved-send-status').textContent()).includes('not stopped'), 'Warning implies the writer was stopped');
    await page.evaluate(async () => { await syncOperations(); await syncSnapshot({force:true,refreshView:true}); });
    check(await page.locator('#unconfirmed-send').isVisible(), 'Polling/unchanged history hid the warning');
    check((await page.locator('#saved-send-status').textContent()).includes('not stopped'), 'Polling lost the failure detail');
    const after = await (await page.request.get(base+'/sessions/session_b/history')).json();
    check(JSON.stringify(before) === JSON.stringify(after), 'Stop mutated history beside a fenced writer');
    const {operations} = await (await page.request.get(base+'/sessions/session_b/operations')).json();
    check(operations.length === 1 && operations[0].state === 'failed' && operations[0].outcome.status === 409, 'No-target Stop was not one explicit failed operation');
    const replay = await page.request.post(base+'/sessions/session_b/operations',{data:{request_id:operations[0].id,message:'!stop'}});
    check(replay.ok() && (await replay.json()).operation.id === operations[0].id, 'Stop replay created a different operation');
    check((await (await page.request.get(base+'/__fixture/events')).json()).events.length === 0, 'No-target Stop launched another writer');
    return {passed:true,providers:0,checks:['real held prior fence','visible not-stopped warning after polling','unchanged history','one failed operation','no new writer']};
}

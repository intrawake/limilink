// Companion navigation checks for the isolated fixture server, with real API
// mutations but delayed HTTP responses. Created fixtures are deleted.
async page => {
    if (!page.url().startsWith('http://127.0.0.1:11012/')) throw new Error('Use the isolated fixture server.');
    const check = (condition, message) => { if (!condition) throw new Error(message); };
    const row = id => page.locator(`.session-row[data-session-id="${id}"]`);
    const settled = () => page.waitForFunction(() => !document.querySelector('#new-session-btn').disabled);
    const select = async id => {
        await row(id).locator('.session-link').click();
        await page.waitForFunction(() => document.querySelector('#chat-container').getAttribute('aria-busy') === 'false');
    };
    await page.reload();
    await settled();
    await select('session_a');
    let createdId, createSeen, releaseCreate;
    const created = new Promise(resolve => { createSeen = resolve; });
    const createGate = new Promise(resolve => { releaseCreate = resolve; });
    await page.route('**/sessions', async route => {
        if (route.request().method() !== 'POST') { await route.continue(); return; }
        const response = await route.fetch();
        createdId = (await response.json()).session_id;
        createSeen();
        await createGate;
        await route.fulfill({ response });
    });
    await page.locator('#new-session-btn').click();
    await created;
    await select('session_b');
    releaseCreate();
    await settled();
    check(await page.locator('#session-directory').textContent() === 'session_b', 'Late create response hijacked navigation');
    check(await row(createdId).count() === 1, 'Created session missing from sidebar');
    await page.unroute('**/sessions');

    // Delayed trash acknowledgements must not hijack newer navigation.
    await select(createdId);
    let trashSeen, releaseTrash;
    const trashed = new Promise(resolve => { trashSeen = resolve; });
    const trashGate = new Promise(resolve => { releaseTrash = resolve; });
    await page.route(`**/sessions/${createdId}/trash`, async route => {
        const response = await route.fetch();
        trashSeen();
        await trashGate;
        await route.fulfill({ response });
    });
    let confirmations = 0;
    const unexpectedDialog = dialog => { confirmations++; dialog.dismiss(); };
    page.on('dialog', unexpectedDialog);
    await row(createdId).locator('.trash-button').click();
    await trashed;
    await select('session_a');
    releaseTrash();
    await settled();
    check(await page.locator('#session-directory').textContent() === 'session_a', 'Late trash response hijacked navigation');
    check(await row(createdId).evaluate(element => element.classList.contains('trashed')), 'Trash fixture was not grey');
    check(confirmations === 0, 'Trash unexpectedly required confirmation');
    page.off('dialog', unexpectedDialog);
    await page.unroute(`**/sessions/${createdId}/trash`);
    check((await page.request.delete(`http://127.0.0.1:11012/sessions/${createdId}/trash`)).ok(), 'Fixture Undo failed');
    check((await page.request.delete(`http://127.0.0.1:11012/sessions/${createdId}`)).ok(), 'Fixture cleanup failed');
    await page.locator('#refresh-sessions').click();
    await settled();
    check(await row(createdId).count() === 0, 'Deleted fixture still visible');

    // Automatic creation uses the same real POST endpoint if listing is empty.
    const context = await page.context().browser().newContext();
    const emptyPage = await context.newPage();
    let firstList = true;
    let autoCreated;
    await emptyPage.route('**/session-sidebar', async route => {
        if (firstList) { firstList = false; await route.fulfill({ json: { sessions: [] } }); }
        else await route.continue();
    });
    await emptyPage.route('**/sessions', async route => {
        const response = await route.fetch();
        autoCreated = (await response.json()).session_id;
        await route.fulfill({ response });
    });
    await emptyPage.goto('http://127.0.0.1:11012');
    await emptyPage.waitForFunction(() => document.querySelector('#session-directory').textContent.startsWith('session_') && !document.querySelector('#new-session-btn').disabled);
    check(await emptyPage.locator('#session-directory').textContent() === autoCreated, 'Initial empty-list creation did not select its server-generated ID');
    const cleanup = await emptyPage.request.delete(`http://127.0.0.1:11012/sessions/${autoCreated}`);
    check(cleanup.ok(), 'Automatic-creation fixture cleanup failed');
    await context.close();
    console.log('PASS: delayed create/trash do not hijack selection; trash requires no confirmation; automatic creation uses POST /sessions. No model calls.');
}

// Disposable preview only. Contract-fake admissions; never forwards a POST.
// Replaces the old global two-long-/chat gate with observable ordered admissions.
async page => {
    const base = 'http://127.0.0.1:11012';
    if (!page.url().startsWith(base + '/')) throw Error('Use the isolated fixture.');
    const check = (value, message) => { if (!value) throw Error(message); };
    const records = new Map(), held = [], posts = [];
    const input = page.locator('#message-input');
    const row = id => page.locator(`.session-row[data-session-id="${id}"]`);
    const select = async id => {
        await row(id).locator('.session-link').click();
        await page.waitForFunction(id => currentSession === id && historyReady, id);
    };
    const send = async text => { await input.fill(text); await page.locator('#send-btn').click(); };
    let wake;
    const arrival = count => posts.length >= count ? Promise.resolve() : new Promise(resolve => { wake = { count, resolve }; });
    const op = (index, state, revision = 0, outcome = null) => ({ id: posts[index].request_id,
        session_id: held[index].request().url().split('/').at(-2), sequence: index, revision,
        state, message: posts[index].message, execution_id: null, outcome });
    await page.route('**/sessions/*/operations*', async route => {
        if (route.request().method() === 'POST') {
            held.push(route); posts.push(route.request().postDataJSON());
            if (wake && posts.length >= wake.count) { wake.resolve(); wake = null; }
        } else {
            const [path, query = ''] = route.request().url().split('?'), id = path.split('/').at(-2);
            const wanted = query.split('&').filter(pair => pair.startsWith('request_id=')).map(pair => pair.slice('request_id='.length));
            await route.fulfill({ json: { operations: [...records.values()].filter(item => item.session_id === id && (!wanted.length || wanted.includes(item.id))) } });
        }
    });
    try {
        await page.setViewportSize({ width: 1280, height: 900 });
        await page.bringToFront();
        await page.evaluate(() => { localStorage.clear(); localStorage.setItem('limilink_last_session', 'session_a'); });
        await page.reload(); await select('session_a');
        await page.evaluate(() => {
            window.boundaries=[];
            document.addEventListener('limilink:human-send', event => boundaries.push(event.detail));
        });
        const text = '  Identical exact text\n';
        await send(text); await arrival(1);
        await send(text);
        check(posts.length === 1, 'Second click overtook the first admission');
        check(await page.locator('#typing').textContent() === 'Sending…', 'Transient staging is not visible');
        const first = op(0, 'running'); records.set(first.id, first);
        await held[0].fulfill({ status: 202, json: { operation: first } });
        await arrival(2);
        const second = op(1, 'queued'); records.set(second.id, second);
        await held[1].fulfill({ status: 202, json: { operation: second } });
        check(posts[0].message === text && posts[1].message === text, 'Exact text was normalized');
        check(posts[0].request_id !== posts[1].request_id, 'Distinct intents share identity');
        for (const body of posts) check(/^[0-9a-f]{32}$/.test(body.request_id), 'Invalid identity');
        // Both X operations remain executing/queued; Y must not wait for either outcome.
        await select('session_b');
        await send('!agent pi'); await arrival(3);
        const third = op(2, 'queued'); records.set(third.id, third);
        await held[2].fulfill({ status: 202, json: { operation: third } });
        await page.waitForFunction(() => document.querySelector('#typing').textContent === 'Queued');
        await input.fill('Keep B draft');
        await select('session_a');
        for (const body of posts.slice(0, 2)) {
            check(await page.locator(`.message[data-request-id="${body.request_id}"]`).count() === 1, 'Snapshot lost or duplicated an exact optimistic identity');
        }
        await select('session_b');
        check(await input.inputValue() === 'Keep B draft', 'Navigation changed another session draft');
        check(await page.evaluate(() => boundaries.length) === 3, 'Reconciliation emitted a human send');
        check(posts.length === 3, 'Unexpected automatic POST');
        return { passed: true, posts: 3, providers: 0, cases: ['ordered short admission', 'visible transient Sending', 'exact text and independent identities', 'two busy A operations do not block B', 'Queued is not running', 'draft/navigation preserved'] };
    } finally {
        await page.evaluate(() => pauseUpdates()).catch(() => {});
        for (const route of held) { try { await route.abort('failed'); } catch {} }
        await page.unroute('**/sessions/*/operations*');
    }
}

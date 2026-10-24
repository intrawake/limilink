// Disposable tool/sidebar_preview.py --fake-chat --history-size 2000 only.
// ?controller=steady also exercises cached HTML without the new helper tags.
async page => {
    const base = 'http://127.0.0.1:11012';
    if (!page.url().startsWith(base + '/')) throw Error('Use the isolated fixture.');
    const check = (value, message) => { if (!value) throw Error(message); };
    const variant = await page.evaluate(() => new URL(location.href).searchParams.get('controller') || 'follow');
    if (variant === 'steady') {
        const body = await (await page.request.get(base + '/steady.js')).text();
        await page.route('**/follow.js', route => route.fulfill({ body, contentType: 'text/javascript' }));
        const html = (await (await page.request.get(page.url())).text())
            .replace('    <script src="/history-view.js?v=1" defer></script>\n', '')
            .replace('    <script src="/reply-state.js?v=1" defer></script>\n', '')
            .replace('</body>', '<button id="rename-current" hidden>Rename</button></body>');
        await page.route('**/?controller=steady', route => route.fulfill({ body: html, contentType: 'text/html' }));
    }
    const row = id => page.locator(`.session-row[data-session-id="${id}"]`);
    const input = page.locator('#message-input');
    const ready = () => page.waitForFunction(() => !document.querySelector('#send-btn').disabled);
    const frames = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    const visibility = state => page.evaluate(value => {
        Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => value });
        document.dispatchEvent(new Event('visibilitychange'));
    }, state);
    const external = async (id, text) => {
        const response = await page.request.post(base + '/chat', { data: { session_id: id, message: text } });
        check(response.ok(), 'Fake external chat failed');
    };
    const run = Date.now().toString(36);
    let stage = 'initialization';
    try {
        await page.bringToFront();
        await page.setViewportSize({ width: 1280, height: 900 });
        await page.evaluate(() => { localStorage.clear(); sessionStorage.clear(); localStorage.setItem('limilink_last_session', 'session_c'); });
        await page.reload();
        await ready();
        await page.waitForFunction(() => historyCache.get('session_c')?.history.length >= 2000);
        await frames();
        const initial = await page.locator('.message').count();
        check(initial === 50, 'Initial history mounted ' + initial + ' messages instead of50');
        check(await page.locator('.load-older').isVisible(), 'Missing Load older');
        check(await page.locator('.message').last().textContent() !== 'History C', 'Loaded oldest instead of newest history');
        await page.locator('.message').first().evaluate(node => { node.dataset.kept = 'yes'; });
        await page.evaluate(async () => { await syncReplyBatch(); });
        check(await page.locator('.session-unread').count() === 0, 'First visit flooded historical unread badges');

        // A canonical append preserves old nodes. Viewing a reply at bottom acknowledges it.
        stage = 'incremental append';
        const first = 'Incremental append ' + run;
        await external('session_c', first);
        await page.waitForFunction(text => document.querySelector('#chat-container').textContent.includes('Fixture reply: ' + text), first);
        await frames();
        // The cached controller predates layout-driven bottom following. Explicitly
        // expose the reply rather than weakening the read-at-bottom requirement.
        if (variant === 'steady') {
            await page.locator('#chat-container').evaluate(node => { node.scrollTop = node.scrollHeight; });
            await page.waitForFunction(() => !replies.isUnread('session_c'));
        }
        check(await page.locator('.message[data-kept="yes"]').count() === 1, 'Canonical append replaced old nodes');
        check(await page.locator('.message').count() === 52, 'Append did not add exactly two canonical messages');
        check(await row('session_c').locator('.session-unread').count() === 0, 'Displayed bottom reply stayed unread');

        // Scrolling up is not reading the new reply; draft/focus and anchor survive.
        stage = 'scrolled-up unread';
        await input.fill('Keep this draft');
        await input.focus();
        await page.locator('#chat-container').evaluate(node => { node.scrollTop = 0; });
        await page.waitForFunction(() => !isScrolledToBottom);
        const top = await page.locator('#chat-container').evaluate(node => node.scrollTop);
        const second = 'Unread while reading older ' + run;
        await external('session_c', second);
        await page.waitForFunction(text => document.querySelector('#chat-container').textContent.includes('Fixture reply: ' + text), second);
        await page.waitForFunction(() => replies.isUnread('session_c'));
        check(await row('session_c').locator('.session-unread').isVisible(), 'Selected-but-scrolled-up reply was silently read');
        check(Math.abs(await page.locator('#chat-container').evaluate(node => node.scrollTop) - top) < 2, 'Append moved reading position');
        check(await input.inputValue() === 'Keep this draft' && await input.evaluate(node => node === document.activeElement), 'Append changed draft/focus');

        // Working and unread are independent and remain visible beside a long title.
        await page.request.patch(base + '/sessions/session_c/title', { data: { title: 'A long conversation title that must truncate before its status indicators' } });
        await page.evaluate(() => refreshSessions(true));
        stage = 'working and unread';
        const third = 'Working and unread coexist ' + run;
        const working = external('session_c', third);
        await page.waitForFunction(() => serverBusy.has('session_c'));
        check(await row('session_c').locator('.session-unread').isVisible(), 'Working cleared unread');
        check(await row('session_c').locator('.session-working').isVisible(), 'Working marker missing');
        const fit = await row('session_c').locator('.session-status').evaluate(node => {
            const box = node.getBoundingClientRect(), parent = node.closest('.session-link').getBoundingClientRect();
            return box.width > 0 && box.right <= parent.right + 1 && box.left >= parent.left;
        });
        check(fit, 'Status slot clipped on a long title');
        await working;
        await page.waitForFunction(text => document.querySelector('#chat-container').textContent.includes('Fixture reply: ' + text), third);
        await page.locator('#chat-container').evaluate(node => { node.scrollTop = node.scrollHeight; });
        await page.waitForFunction(() => !replies.isUnread('session_c'));

        // Prepends retain the existing first-visible message at its viewport offset.
        await page.locator('#chat-container').evaluate(node => { node.scrollTop = 0; });
        await page.waitForFunction(() => !isScrolledToBottom);
        stage = 'prepend anchor';
        const anchor = page.locator('.message').first();
        const anchorTop = await anchor.evaluate(node => { node.dataset.anchor = 'yes'; return node.getBoundingClientRect().top; });
        const countBefore = await page.locator('.message').count();
        await page.locator('.load-older').click();
        await frames();
        check(await page.locator('.message').count() === countBefore + 50, 'Load older did not prepend50');
        const anchorAfter = await page.locator('.message[data-anchor="yes"]').evaluate(node => node.getBoundingClientRect().top);
        check(Math.abs(anchorAfter - anchorTop) < 2, 'Prepend jumped the reading anchor');

        // Semantic equality may have a different revision; no DOM replacement is needed.
        stage = 'semantic rewrite';
        const canonical = await (await page.request.get(base + '/sessions/session_c/snapshot')).json();
        await page.route('**/sessions/session_c/snapshot*', route => route.fulfill({ json: { ...canonical, revision: 'format-only-' + run } }));
        await page.evaluate(() => syncSnapshot({ force: true }));
        check(await page.locator('.message[data-anchor="yes"]').count() === 1, 'Formatting-only revision replaced messages');
        await page.unroute('**/sessions/session_c/snapshot*');

        // Rewrites/truncation are not append and cannot reuse old positional identities.
        await page.route('**/sessions/session_c/snapshot*', route => route.fulfill({ json: {
            revision: 'rewritten-' + run, busy: false, busy_sessions: [], reply: { state: 'unknown' },
            history: [{ role: 'bot', content: 'Rewritten canonical history' }],
        } }));
        await page.evaluate(() => syncSnapshot({ force: true }));
        check(await page.locator('.message').count() === 1 && await page.locator('.message[data-anchor="yes"]').count() === 0, 'Rewrite retained stale nodes');
        await page.unroute('**/sessions/session_c/snapshot*');
        await page.evaluate(() => syncSnapshot({ force: true }));
        await ready();

        // Offscreen replies from another client badge without any local Send/receipt.
        stage = 'offscreen unread';
        const elsewhere = 'Unread offscreen ' + run;
        await external('session_a', elsewhere);
        await page.waitForFunction(() => replies.isUnread('session_a'));
        check(!await page.evaluate(() => pendingSends.has('session_a')), 'External test accidentally used a local Send');
        check(await row('session_a').locator('.session-unread').isVisible(), 'Offscreen reply not badged');

        // Reading this exact token in another tab clears it here, not every newer reply.
        stage = 'cross-tab read';
        const other = await page.context().newPage();
        try {
            await other.addInitScript(() => localStorage.setItem('limilink_last_session', 'session_a'));
            await other.goto(base + '/');
            await other.bringToFront();
            await other.waitForFunction(() => !document.querySelector('#send-btn').disabled && currentSession === 'session_a');
            await other.waitForFunction(() => !replies.isUnread('session_a'));
            await page.waitForFunction(() => !replies.isUnread('session_a'));
        } finally { await other.close(); }
        await page.bringToFront();

        // Hidden/covered content is not read, even after a selected snapshot arrives.
        stage = 'mobile overlay';
        await page.setViewportSize({ width: 375, height: 812 });
        await page.locator('#sidebar-toggle').click();
        await visibility('hidden');
        const covered = 'Unread behind mobile drawer ' + run;
        await external('session_c', covered);
        await visibility('visible');
        await page.waitForFunction(() => replies.isUnread('session_c'));
        check(await row('session_c').locator('.session-unread').isVisible(), 'Covered conversation falsely acknowledged reply');
        await page.locator('#sidebar-close').click();
        if (variant === 'steady') await page.locator('#chat-container').evaluate(node => { node.scrollTop = node.scrollHeight; });
        await page.waitForFunction(() => !replies.isUnread('session_c'));
        check(await input.inputValue() === 'Keep this draft', 'Unread tracking lost the draft');

        // Removing an unadmitted optimistic bubble must restore the empty state.
        stage = 'empty recovery';
        const previousSession = await page.evaluate(() => currentSession);
        await page.locator('#sidebar-toggle').click();
        await page.locator('#new-session-btn').click();
        await page.waitForFunction(previous => currentSession && currentSession !== previous && historyReady, previousSession);
        await ready();
        await page.route('**/chat', route => route.fulfill({ status: 500, json: { detail: 'Synthetic unadmitted failure' } }));
        await input.fill('Rejected before admission');
        await page.locator('#send-btn').click();
        await page.waitForFunction(() => document.querySelector('#chat-container .empty-conversation')
            && !document.querySelector('#unconfirmed-send').hidden && !pendingSends.has(currentSession))
            .catch(error => { throw Error('Empty optimistic recovery: ' + error.message); });
        check(await page.locator('.message').count() === 0, 'Failed optimistic message remained canonical');
        await page.unroute('**/chat');
        return { controller: variant, initialNodes: initial, canonicalMessages: canonical.history.length,
            append: 'old nodes retained', prepend: 'anchor retained', unread: 'selected-away/offscreen/cross-tab/mobile-overlay',
            network: 'fixture only; no providers' };
    } catch (error) {
        const state = await page.evaluate(() => ({
            id: currentSession, ready: historyReady, connected, focus: document.hasFocus(),
            visibility: document.visibilityState, inert: conversation.inert,
            gap: chat.scrollHeight - chat.clientHeight - chat.scrollTop,
            messages: chat.querySelectorAll('.message').length,
            canonical: historyCache.get(currentSession)?.history.length,
            pending: pendingSends.size, saved: unconfirmedSends.get(currentSession)?.length || 0,
            helperEmptyRestore: !!globalThis.LimilinkHistory?.create.toString().includes('!next.length && !transients.length'),
        })).catch(() => ({}));
        throw Error(stage + ': ' + error.message + '; ' + JSON.stringify(state));
    }
}

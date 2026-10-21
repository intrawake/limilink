// Isolated fixture. Desktop selection (including touch) focuses; phones never do.
async page => {
    const base = 'http://127.0.0.1:11012/';
    if (!page.url().startsWith(base)) throw new Error('Use the isolated fixture.');
    const check = (condition, message) => { if (!condition) throw new Error(message); };
    const results = [];
    const browser = page.context().browser();
    for (const variant of [
        { name: 'desktop', expectFocus: true, viewport: { width: 1440, height: 900 }, hasTouch: false, isMobile: false },
        { name: 'touch laptop', expectFocus: true, mobileHint: false, viewport: { width: 1440, height: 900 }, hasTouch: true, isMobile: false },
        { name: 'narrow desktop', expectFocus: false, viewport: { width: 640, height: 800 }, hasTouch: false, isMobile: false },
        { name: 'phone portrait', expectFocus: false, mobileHint: true, viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true },
        { name: 'phone landscape', expectFocus: false, mobileHint: true, viewport: { width: 844, height: 390 }, hasTouch: true, isMobile: true },
        { name: 'iPhone landscape fallback', expectFocus: false, mobileHint: null, userAgent: 'Mozilla/5.0 (iPhone) TestBrowser', viewport: { width: 844, height: 390 }, hasTouch: true, isMobile: true },
        { name: 'Android tablet fallback', expectFocus: false, mobileHint: null, userAgent: 'Mozilla/5.0 (Linux; Android) TestBrowser', viewport: { width: 1100, height: 800 }, hasTouch: true, isMobile: true },
        { name: 'iPad desktop-UA fallback', expectFocus: false, mobileHint: null, platform: 'MacIntel', viewport: { width: 1100, height: 800 }, hasTouch: true, isMobile: true }
    ]) {
        const { name, expectFocus, mobileHint, platform, ...options } = variant;
        const context = await browser.newContext(options);
        if (mobileHint !== undefined || platform) await context.addInitScript(({ mobileHint, platform }) => {
            if (mobileHint !== undefined) Object.defineProperty(navigator, 'userAgentData', { configurable: true, value: mobileHint === null ? undefined : { mobile: mobileHint } });
            if (platform) {
                Object.defineProperty(navigator, 'platform', { configurable: true, value: platform });
                Object.defineProperty(navigator, 'maxTouchPoints', { configurable: true, value: 5 });
            }
        }, { mobileHint, platform });
        const client = await context.newPage();
        let posts = 0;
        client.on('request', request => { if (request.method() === 'POST') posts++; });
        try {
            await client.goto(base);
            await client.waitForFunction(() => !document.querySelector('#new-session-btn').disabled && activeSnapshot === null);
            const modality = await client.evaluate(() => ({ fine: matchMedia('(hover: hover) and (pointer: fine)').matches, width: innerWidth, mobileHint: navigator.userAgentData?.mobile ?? null }));
            const row = id => client.locator(`.session-row[data-session-id="${id}"] .session-link`);
            const input = client.locator('#message-input');
            const focused = () => client.evaluate(() => document.activeElement.id === 'message-input');
            const activate = async (id, method) => {
                if (await client.evaluate(() => mobile.matches && !app.classList.contains('sidebar-open'))) await client.locator('#sidebar-toggle').click();
                if (method === 'keyboard') { await row(id).focus(); await client.keyboard.press('Enter'); }
                else await row(id)[method]();
                await client.waitForFunction(() => activeSnapshot === null);
                return focused();
            };
            const startup = await focused();
            const mouseFocused = await activate('session_b', 'click');
            if (expectFocus) await input.fill('B draft');
            const keyboardFocused = await activate('session_c', 'keyboard');
            await activate('session_b', 'click');
            if (expectFocus) check(await input.inputValue() === 'B draft', 'Session focus lost draft');
            // Refresh must respect focus moved to another control, on every device.
            await client.locator('#activity-toggle').focus();
            await client.evaluate(() => syncSnapshot({ force: true }));
            check(await client.evaluate(() => document.activeElement.id) === 'activity-toggle', 'Background refresh stole focus');
            let touchFocused = null, sameSessionTouchFocused = null;
            if (options.hasTouch) {
                touchFocused = await activate('session_c', 'tap');
                await client.locator('#activity-toggle').focus();
                sameSessionTouchFocused = await activate('session_c', 'tap');
            }
            results.push({ name, modality, startup, mouseFocused, keyboardFocused, touchFocused, sameSessionTouchFocused, expectFocus });
            check(posts === 0, 'Focus switching unexpectedly posted something');
        } finally { await context.close(); }
    }
    const passed = results.every(result => !result.startup && result.mouseFocused === result.expectFocus && result.keyboardFocused === result.expectFocus
        && (result.touchFocused === null || (result.touchFocused === result.expectFocus && result.sameSessionTouchFocused === result.expectFocus)));
    check(passed, `Session autofocus regression: ${JSON.stringify(results)}`);
    return { passed, results, providers: 0, chatPosts: 0 };
}

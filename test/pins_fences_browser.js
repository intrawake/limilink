// Disposable tool/delivery_fixture.py on 11018 only. No provider calls.
async page => {
    const base = 'http://127.0.0.1:11018';
    if (!page.url().startsWith(base + '/')) throw Error('Use disposable fixture');
    const check = (value, message) => { if (!value) throw Error(message); };
    const nested = 'markdown\n# Verbatim example\n```js\nconsole.log("nested");\n```\n[not linked](/literal)\n<img src=x onerror=window.fenceXSS=true>\n';
    const history = [
        {role:'bot', content:'Before [outside](/outside)\n````' + nested + '````\nAfter'},
        {role:'user', content:'~~~~text\n```\n~~~\n[also literal](/literal)\n~~~~~\nDone'},
        {role:'bot', content:'````markdown\n```\n[unfinished](/no)\n```'},
    ];
    await page.route('**/sessions/session_a/snapshot*', route => route.fulfill({json:{
        revision:'nested-fences',history,busy:false,busy_sessions:[],reply:{state:'unknown'},send_identities:true,
    }}));
    try {
        await page.setViewportSize({width:1440,height:900});
        await page.evaluate(() => { localStorage.setItem('limilink_last_session','session_a'); });
        await page.reload();
        await page.waitForFunction(() => historyReady && currentSession === 'session_a');
        await page.waitForFunction(() => document.querySelector('#media-toggle').textContent.startsWith('Pins ('));
        const chat = page.locator('#chat-container');
        check(await chat.locator('pre code').count() === 2, 'Nested fences split the code blocks');
        check(await chat.locator('pre code').first().textContent() === nested, 'Nested Markdown bytes changed');
        check(await chat.locator('pre code').nth(1).textContent() === 'text\n```\n~~~\n[also literal](/literal)\n', 'Tilde/shorter fence rule failed');
        check(await chat.locator('a').count() === 1 && await chat.locator('a').textContent() === 'outside', 'Literal code became links');
        check(await chat.locator('img,script').count() === 0 && !await page.evaluate(() => window.fenceXSS), 'Code became HTML');
        check(await chat.locator('.message').last().textContent() === history[2].content, 'Unclosed fence lost text');
        await page.locator('#message-input').fill('draft retained');
        const chatWidth = await chat.evaluate(node => node.clientWidth);
        await page.locator('#media-toggle').click();
        check(await page.locator('#session-media').isVisible(), 'Pins button did not open panel');
        check(await chat.evaluate(node => node.clientWidth) < chatWidth, 'Desktop pins did not form a sidebar');
        check(await page.evaluate(() => !document.querySelector('#conversation').inert), 'Desktop chat became inert');
        await page.locator('#activity-toggle').click();
        check(await page.locator('#session-media').isHidden() && await page.locator('#activity-panel').isVisible(), 'Activity did not replace Pins');
        await page.locator('#media-toggle').click();
        check(await page.locator('#activity-panel').isHidden() && await page.locator('#session-media').isVisible(), 'Pins did not replace Activity');
        await page.keyboard.press('Escape');
        check(await page.evaluate(() => document.activeElement.id === 'media-toggle'), 'Escape lost focus');
        for (const width of [390,320]) {
            await page.setViewportSize({width,height:844});
            await page.locator('#media-toggle').click();
            check(await page.locator('#session-media').getAttribute('aria-modal') === 'true', 'Mobile pins lacks modal semantics');
            check(await page.evaluate(() => document.querySelector('#conversation').inert), 'Mobile background not inert');
            check(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'Phone viewport overflow');
            await page.locator('#media-close').focus();
            await page.keyboard.press('Shift+Tab');
            check(await page.evaluate(() => document.querySelector('#session-media').contains(document.activeElement)), 'Focus escaped pins');
            await page.locator('#media-close').click();
            check(await page.evaluate(() => !document.querySelector('#conversation').inert && document.activeElement.id === 'media-toggle'), 'Closing pins left mobile chat inert');
            await page.locator('#activity-toggle').click();
            check(await page.locator('#activity-panel').getAttribute('aria-modal') === 'true', 'Activity overlay regressed');
            await page.locator('#activity-close').click();
        }
        await page.locator('#media-toggle').click();
        await page.setViewportSize({width:1440,height:900});
        await page.waitForFunction(() => !document.querySelector('#conversation').inert && document.querySelector('#media-backdrop').hidden);
        await page.setViewportSize({width:390,height:844});
        await page.waitForFunction(() => document.querySelector('#conversation').inert && !document.querySelector('#media-backdrop').hidden);
        await page.locator('#media-backdrop').click({position:{x:5,y:50}});
        check(await page.locator('#session-media').isHidden(), 'Backdrop did not close pins');
        check(await page.locator('#message-input').inputValue() === 'draft retained' && !await page.locator('#send-btn').isDisabled(), 'Panels disturbed draft or Send');
        return {passed:true,checks:['nested backtick/tilde fences','literal links/HTML/unclosed fence','desktop sidebar/switching','mobile focus/Escape/backdrop','320/390px layouts','resize modal state','draft and Send preserved']};
    } finally {
        await page.unroute('**/sessions/session_a/snapshot*');
    }
}

// Disposable fixture; menu-button drawer, no application edge-swipe interception.
async page => {
    if (!page.url().startsWith('http://127.0.0.1:11012/')) throw new Error('Use the isolated fixture.');
    const check = (value, message) => { if (!value) throw new Error(message); };
    const context = await page.context().browser().newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
    const phone = await context.newPage();
    let posts = 0;
    phone.on('request', request => { if (request.method() === 'POST') posts++; });
    try {
        await phone.goto(page.url());
        await phone.waitForFunction(() => !document.querySelector('#new-session-btn').disabled);
        await phone.locator('#message-input').fill('Keep this draft');
        await phone.locator('#message-input').blur();
        // Untrusted events test app interception without exercising Chrome's own back action.
        await phone.evaluate(() => {
            const target = document.querySelector('#chat-container');
            const start = new Touch({ identifier: 1, target, clientX: 12, clientY: 350 });
            const end = new Touch({ identifier: 1, target, clientX: 150, clientY: 350 });
            for (const [type, touches, changedTouches] of [
                ['touchstart', [start], [start]], ['touchmove', [end], [end]], ['touchend', [], [end]],
            ]) {
                const event = new TouchEvent(type, { bubbles: true, cancelable: true, touches, changedTouches });
                if (!target.dispatchEvent(event) || event.defaultPrevented) throw new Error('App still intercepted a side swipe');
            }
        });
        check(await phone.locator('#session-sidebar').evaluate(element => element.inert), 'Side swipe opened the drawer');
        check(await phone.locator('#message-input').inputValue() === 'Keep this draft', 'Swipe changed draft');
        await phone.locator('#sidebar-toggle').click();
        check(await phone.locator('#session-sidebar').isVisible(), 'Menu button no longer opens drawer');
        check(await phone.evaluate(() => document.activeElement.id === 'sidebar-close'), 'Menu focused a text field');
        check(await phone.locator('#reorder-hint').count() === 0, 'Removed help text returned');
        const create = await phone.locator('#new-session-btn').boundingBox();
        const refresh = await phone.locator('#refresh-sessions').boundingBox();
        check(create.x < refresh.x && Math.abs(create.y - refresh.y) < 1 && create.width < 100, 'Compact leftmost New/Refresh row changed');
        await phone.locator('#sidebar-close').click();
        check(await phone.locator('#session-sidebar').evaluate(element => element.inert), 'Close button failed');
        check(posts === 0, 'Opening/closing drawer sent or created something');
        return { passed: true, edgeInterception: false, compactToolbar: true, menuButton: true, providers: 0 };
    } finally { await context.close(); }
}

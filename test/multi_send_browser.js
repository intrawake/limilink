// Owned --fake-chat fixture only: one normal POST reaches its local echo backend.
async page => {
    const base = 'http://127.0.0.1:11012';
    if (!page.url().startsWith(base + '/')) throw Error('Use the isolated fixture.');
    const check = (value, message) => { if (!value) throw Error(message); };
    const variant = await page.evaluate(() => new URL(location.href).searchParams.get('controller') || 'follow');
    if (variant === 'steady') {
        const script = await (await page.request.get(base + '/steady.js')).text();
        const css = await (await page.request.get(base + '/drawer.css')).text();
        const html = (await (await page.request.get(page.url())).text()).replace('</body>', '<button id="rename-current" hidden>Rename</button></body>');
        await page.route('**/follow.js', route => route.fulfill({body:script,contentType:'text/javascript'}));
        await page.route('**/arrange.css', route => route.fulfill({body:css,contentType:'text/css'}));
        await page.route('**/?controller=steady', route => route.fulfill({body:html,contentType:'text/html'}));
    }
    const held = [], posts = [];
    const row = id => page.locator(`.session-row[data-session-id="${id}"]`);
    const ready = id => page.waitForFunction(id => currentSession === id && historyReady && connected && !checkingSnapshot, id);
    const input = page.locator('#message-input');
    await page.setViewportSize({width:1280,height:900});
    await page.bringToFront();
    await page.evaluate(() => {localStorage.clear();sessionStorage.clear();localStorage.setItem('limilink_last_session','session_a');});
    await page.reload(); await ready('session_a');
    check(await page.evaluate(() => sendIdentityAvailable && globalThis.LimilinkHistory.version === 3), 'Exact-ID capability/helper absent');
    await page.evaluate(() => { globalThis.humanSends=[];document.addEventListener('limilink:human-send',event=>humanSends.push(event.detail.sessionId+':'+event.detail.requestId)); });
    await page.route('**/chat', route => { held.push(route); posts.push(route.request().postDataJSON()); });
    let forwarded;
    try {
        const text = 'Identical pending message ' + Date.now().toString(36);
        for (let i=0;i<2;i++) {
            await input.fill(text); await page.locator('#send-btn').click();
            await page.waitForFunction(count=>activePosts.size===count,i+1);
        }
        check(posts.length===2 && posts[0].request_id!==posts[1].request_id, 'Distinct sends lost their identities');
        const [a,b] = posts.map(item=>item.request_id);
        check(await page.evaluate(() => pendingFor('session_a').length===2), 'Second send overwrote first');
        await page.evaluate(() => syncSnapshot({force:true}));
        check(await page.locator(`.message[data-request-id="${a}"]`).count()===1
            && await page.locator(`.message[data-request-id="${b}"]`).count()===1, 'Unchanged snapshot discarded or duplicated optimistic messages');

        // The HTTP limit is global, but !stop has independent capacity on another session.
        await row('session_b').locator('.session-link').click(); await ready('session_b');
        await input.fill('Draft on B');
        check(await page.locator('#send-btn').isDisabled(), 'Ordinary transports exceeded global bound');
        // IDs are scoped by session: a control in B may reuse an ID pending in A.
        await page.evaluate(id => { globalThis.originalSendId=newSendId;newSendId=()=>id; }, b);
        await input.fill('!stop');
        check(await page.locator('#send-btn').isEnabled(), 'Stop was blocked behind ordinary sends');
        await page.locator('#send-btn').click();
        await page.waitForFunction(() => activePosts.size===3);
        await page.evaluate(() => {newSendId=originalSendId;});
        check(posts.length===3 && posts[2].message==='!stop', 'Stop did not bypass ordinary capacity');
        check(await page.evaluate(() => pendingFor('session_a').length===2), 'Stop overwrote original pending sends');
        await held[2].fulfill({json:{reply:'No active agent process found for this session.'}});
        await page.waitForFunction(() => activePosts.size===2 && !pendingSends.has('session_b'));
        await input.fill('Keep this draft');

        // Admit only A. Its exact canonical ID must not consume same-text B.
        forwarded = held[0].fetch();
        await page.waitForFunction(async id => {
            const data=await(await fetch('/sessions/session_a/snapshot?request_id='+id)).json();
            return data.history.some(item=>item.request_id===id);
        },a);
        await row('session_a').locator('.session-link').click(); await ready('session_a');
        await page.evaluate(() => syncSnapshot({force:true}));
        check(await page.locator(`.message[data-request-id="${a}"]`).count()===1
            && await page.locator(`.message[data-request-id="${b}"]`).count()===1, 'Partial admission matched by text instead of ID');
        await row('session_b').locator('.session-link').click(); await ready('session_b');
        check(await input.inputValue()==='Keep this draft', 'Concurrent sends changed another draft');
        const response = await forwarded; forwarded=null;
        await page.waitForFunction(id=>!pendingFor('session_a').some(item=>item.id===id),a);
        await page.waitForFunction(() => activePosts.size===1);
        check(await page.evaluate(id=>pendingFor('session_a').some(item=>item.id===id),b), 'Completion retired sibling send');
        try { await held[0].fulfill({response}); } catch { /* Exact terminal receipt already aborted its held transport. */ }
        await row('session_a').locator('.session-link').click(); await ready('session_a');
        await page.evaluate(id => {newSendId=()=>id;},b);
        await input.fill('Do not overwrite the pending identity');await page.locator('#send-btn').click();
        check(await input.inputValue()==='Do not overwrite the pending identity' && posts.length===3, 'A colliding ID overwrote a same-session Send');
        await page.evaluate(() => {newSendId=originalSendId;});
        await held[1].fulfill({status:429,json:{detail:'Fixture refusal for B'}});
        await page.waitForFunction(id=>unconfirmedSends.get('session_a')?.some(item=>item.id===id && item.failed),b);
        await row('session_a').locator('.session-link').click(); await ready('session_a');
        check(await page.evaluate(id=>unconfirmedSends.get('session_a').length===1 && unconfirmedSends.get('session_a')[0].id===id,b), 'Failure was not retained independently');
        check(await page.locator(`.message[data-request-id="${a}"]`).count()===1
            && await page.locator(`.message[data-request-id="${b}"]`).count()===0, 'Canonical/failed optimistic display is wrong');
        check(await page.evaluate(() => humanSends.length===3 && new Set(humanSends).size===3), 'Reconciliation emitted a fresh-human-Send event');

        // A deleted conversation's unresolved text stays visible and can be restored here explicitly.
        await page.locator('#dismiss-unconfirmed').click();
        await page.evaluate(() => {
            const request={id:'d'.repeat(32),text:'Recover the removed conversation',settled:false};
            addPending('removed_session',request);addDisplay('removed_session',request);recoverMissingSessions();
        });
        check((await page.locator('#saved-send-status').textContent()).includes('removed conversations'), 'Removed-session recovery was inaccessible');
        await input.fill('Keep current draft');
        await page.locator('#restore-unconfirmed').click();
        check(await input.inputValue()==='Keep current draft\n\nRecover the removed conversation', 'Removed-session restoration lost text or overwrote the current draft');
        check(await page.evaluate(() => !unconfirmedSends.has('removed_session') && !displaySends.has('removed_session')), 'Recovered orphan permanently consumed capacity');

        // Metadata-only changes preserve canonical nodes, but reconcile local IDs exactly.
        const rendering = await page.evaluate(() => {
            const host=document.createElement('div');document.body.append(host);
            const view=LimilinkHistory.create(host,{empty:()=>{const node=document.createElement('div');host.replaceChildren(node);return node;},onPrepend(){}});
            const a='a'.repeat(32),b='b'.repeat(32),local=[{id:b,text:'same'}];
            view.render([{role:'user',content:'same'}],local);
            if(host.querySelectorAll('.message').length!==2)throw Error('Text incorrectly acknowledged local message');
            const original=view.nodeAt(0); original.dataset.kept='yes';
            view.render([{role:'user',content:'same',request_id:b}],local);
            if(host.querySelectorAll('.message').length!==1 || view.nodeAt(0)!==original)throw Error('Metadata-only admission rebuilt prefix or left duplicate');
            view.render([{role:'bot',content:'same',request_id:b}],local);
            if(host.querySelectorAll('.message').length!==2)throw Error('Bot metadata acknowledged a user send');
            view.render([{role:'user',content:'same',request_id:b},{role:'user',content:'same',request_id:b}],local);
            if(host.querySelectorAll('.message').length!==3)throw Error('Ambiguous duplicate IDs acknowledged a send');
            view.render([], [{id:a,text:'first'},{id:b,text:'second'}]);
            if(host.querySelectorAll('.message').length!==2)throw Error('Rewrite lost unacknowledged local messages');
            host.remove();return 'exact IDs, metadata-only reuse, bot/duplicate rejection, rewrite preservation';
        });
        check(posts.length===3, 'Unexpected automatic POST/replay');
        return {controller:variant,ordinaryPosts:2,controlPosts:1,identicalText:'independent IDs/partial admission',
            transport:'global ordinary bound + reserved Stop; terminal receipt releases held transport',rendering,
            navigation:'draft preserved',failure:'only exact send retained',providers:0};
    } finally {
        if(forwarded) await forwarded.catch(()=>{});
        for(const route of held) {try{await route.abort('failed');}catch{}}
        await page.unroute('**/chat');
        if(variant==='steady') {await page.unroute('**/follow.js');await page.unroute('**/arrange.css');await page.unroute('**/?controller=steady');}
    }
}

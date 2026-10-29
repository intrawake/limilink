// Disposable --fake-chat fixture only. All chat POSTs intercepted, no provider/process signals.
async page => {
    const base='http://127.0.0.1:11012';
    if(!page.url().startsWith(base+'/'))throw Error('Use the isolated fixture.');
    const check=(value,message)=>{if(!value)throw Error(message);};
    const variant = 'follow';
    const snapshot=await(await page.request.get(base+'/sessions/session_a/snapshot')).json();
    const reads=[],held=[],posts=[];
    const input=page.locator('#message-input'),button=page.locator('#send-btn');
    await page.setViewportSize({width:1280,height:900});await page.bringToFront();
    await page.route('**/sessions/session_a/snapshot*',route=>{reads.push(route);});
    await page.route('**/chat',route=>{held.push(route);posts.push(route.request().postDataJSON());});
    try{
        await page.evaluate(()=>{localStorage.clear();sessionStorage.clear();localStorage.setItem('limilink_last_session','session_a');});
        await page.reload();
        await page.waitForFunction(()=>currentSession==='session_a' && checkingSnapshot && !historyReady);
        check(await button.isEnabled() && await input.isEnabled(),'Initial history read disabled the selected conversation');
        await page.evaluate(()=>{globalThis.availabilityEvents=[];document.addEventListener('limilink:human-send',event=>availabilityEvents.push(event.detail.requestId));});
        await input.fill('Enter during initial history loading');await input.press('Enter');
        await page.waitForFunction(()=>activePosts.size===1);
        check(posts.length===1,'Initial Enter did not actually POST');

        // Focus revalidation, failed reads and last-known trash are not POST admission authority.
        await page.evaluate(()=>{
            connected=false;historyReady=false;checkingSnapshot=true;
            sessions.find(item=>item.id===currentSession).delete_at=Date.now()/1000+60;
            serverBusy.add(currentSession);updateInputState();window.dispatchEvent(new Event('focus'));
        });
        check(await button.isEnabled() && await input.isEnabled(),'Stale state disabled composer or action');
        await input.fill('Enter despite failed read and stale trash');await input.press('Enter');
        await page.waitForFunction(()=>activePosts.size===2);
        check(posts.length===2,'Stale state prevented POST');
        await input.fill('Keep full-transport draft');await input.press('Enter');
        check(await button.isEnabled() && await input.inputValue()==='Keep full-transport draft','Backpressure disabled action or lost draft');
        check(posts.length===2 && (await page.locator('#notice').textContent()).includes('Not sent: two requests'),'Full transports silently discarded or queued intent');
        check(await page.evaluate(()=>availabilityEvents.length===2),'Refused intent emitted a fresh Send event');

        await input.fill('!stop');await input.press('Enter');
        await page.waitForFunction(()=>activePosts.size===3);
        check(posts.length===3 && posts[2].message==='!stop','Stop lost reserved transport');
        await held[2].fulfill({json:{reply:'Fixture stop acknowledgement'}});
        await page.waitForFunction(()=>activePosts.size===2);
        await input.fill('Keep newer draft');
        await held[0].fulfill({status:409,json:{detail:'Conversation is trashed'}});
        await page.waitForFunction(id=>unconfirmedSends.get('session_a')?.some(item=>item.id===id && item.failed),posts[0].request_id);
        check(await input.inputValue()==='Keep newer draft','Server rejection overwrote later typing');
        check((await page.locator('#unconfirmed-text').textContent()).includes(posts[0].message),'Server rejection lost original text');
        check(await page.locator('#restore-unconfirmed').isEnabled(),'Stale trash blocked recovery');
        await page.locator('#restore-unconfirmed').click();
        check(await input.inputValue()==='Keep newer draft\n\n'+posts[0].message,'Restoration replaced or lost draft');
        check(posts.length===3,'Restoration silently re-posted');

        // No snapshot will succeed: a failed POST must expose its text immediately, not await GET recovery.
        await input.fill('Immediate uncertain transport text');await input.press('Enter');
        await page.waitForFunction(()=>activePosts.size===2);
        check(posts.length===4,'Recovered transport capacity did not allow a fresh attempt');
        await input.fill('Do not clear this newer draft');await held[3].abort('failed');
        await page.waitForFunction(id=>unconfirmedSends.get('session_a')?.some(item=>item.id===id && !item.failed && item.needsRecovery),posts[3].request_id);
        check(await page.locator('#unconfirmed-send').isVisible(),'Transport failure recovery was hidden until snapshot');
        check((await page.locator('#unconfirmed-text').textContent()).includes(posts[3].message),'Transport failure discarded text');
        check(await input.inputValue()==='Do not clear this newer draft','Transport failure changed newer draft');
        check(await button.isEnabled(),'Failure disabled another attempt');
        await held[1].fulfill({json:{reply:'Fixture normal completion'}});
        await page.waitForFunction(()=>activePosts.size===0);
        check(posts.length===4 && await page.evaluate(()=>availabilityEvents.length===4),'Recovery re-posted or emitted another human Send');
        check(new Set(posts.map(item=>item.request_id)).size===4,'Fresh attempts reused an identity');
        // Explicit restoration wins over any receipt that arrives after transport failure.
        await page.evaluate(id=>{globalThis.discardedAvailabilitySend=unconfirmedSends.get('session_a').find(item=>item.id===id);},posts[3].request_id);
        await page.locator('#restore-unconfirmed').click();
        const restoredDraft='Do not clear this newer draft\n\n'+posts[3].message;
        check(await input.inputValue()===restoredDraft,'Uncertain restoration lost or duplicated text');
        await page.evaluate(()=>{
            const request=discardedAvailabilitySend;
            for(const send of [{id:request.id,state:'missing'},{id:request.id,state:'running'},{id:request.id,state:'complete',outcome:{status:429,body:{detail:'late'}}}]){
                if(reconcileReceipt('session_a',{tracked:request},{send},true))throw Error('Restored request reconciled again');
            }
            if(trackedFor('session_a').includes(request) || (unconfirmedSends.get('session_a')||[]).includes(request))throw Error('Restored uncertainty resurrected/leaked');
        });
        // Restore ordinary canonical reads without disturbing the restored draft.
        await page.unroute('**/sessions/session_a/snapshot*');
        for(const route of reads){try{await route.fulfill({json:snapshot});}catch{}}
        await page.evaluate(()=>syncSnapshot({force:true}));
        check(await input.inputValue()===restoredDraft,'Late canonical read changed restored draft');

        // A no-target click during startup must not prevent automatic first-session creation.
        let created=0,emptyRead,seenRead;
        const readHeld=new Promise(resolve=>{seenRead=resolve;});
        await page.route('**/session-sidebar',route=>{
            if(!created){emptyRead=route;seenRead();}
            else route.fulfill({json:{sessions:[{id:'fresh_session',title:'Fresh session'}],server_time:Date.now()/1000}});
        });
        await page.route('**/sessions',route=>{
            if(route.request().method()!=='POST')return route.fallback();
            created++;return route.fulfill({json:{session_id:'fresh_session'}});
        });
        await page.route('**/sessions/fresh_session/snapshot*',route=>route.fulfill({json:{...snapshot,session_id:'fresh_session',history:[],revision:'fresh'}}));
        await page.reload();await readHeld;
        await button.click();
        check((await page.locator('#notice').textContent()).includes('Choose a conversation'),'No-target click was silent');
        await emptyRead.fulfill({json:{sessions:[],server_time:Date.now()/1000}});
        await page.waitForFunction(()=>currentSession==='fresh_session' && historyReady);
        check(created===1,'No-target notice prevented first-session creation');
        return {controller:variant,passed:true,chatPosts:4,providers:0,checks:['initial Enter','focus/failed read/stale trash admission','explicit draft-preserving backpressure','reserved Stop','server refusal and restoration','immediate uncertain recovery','exact identities/no replay']};
    }finally{
        await page.evaluate(()=>pauseUpdates()).catch(()=>{});
        for(const route of [...held,...reads]){try{await route.abort('failed');}catch{}}
        await page.unroute('**/chat');await page.unroute('**/sessions/session_a/snapshot*');
        await page.unroute('**/session-sidebar');await page.unroute('**/sessions');await page.unroute('**/sessions/fresh_session/snapshot*');
    }
}

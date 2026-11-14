// tool/delivery_fixture.py --paused session_b --hold-prior session_b (disposable only).
async page => {
    const base='http://127.0.0.1:11018';
    if (!page.url().startsWith(base+'/')) throw Error('Use disposable fixture');
    const check=(value,message)=>{if(!value)throw Error(message);};
    let posts=0,sends=0;
    page.on('request',request=>{
        if(request.method()==='POST'&&request.url().endsWith('/sessions/session_b/recovery'))posts++;
        if(request.method()==='POST'&&request.url().endsWith('/sessions/session_b/operations'))sends++;
    });
    await page.evaluate(()=>{localStorage.clear();localStorage.setItem('limilink_last_session','session_b');});
    await page.reload();
    await page.waitForFunction(()=>document.querySelector('#session-directory').textContent==='session_b');
    await page.evaluate(async()=>{await syncOperations();});
    await page.locator('#session-recovery').waitFor({state:'visible'});
    await page.locator('#review-recovery').click();
    await page.waitForFunction(()=>document.querySelector('#recovery-status').textContent.includes('Recovery unavailable'));
    check(await page.locator('#confirm-recovery').isHidden(),'Held legacy/writer lease got a ready confirmation');
    check(posts===0&&sends===0,'Review triggered execution/confirmation');
    const ops=await (await page.request.get(base+'/sessions/session_b/operations')).json();
    const history=await (await page.request.get(base+'/sessions/session_b/history')).json();
    check(ops.recovery_required&&ops.operations[0].state==='indeterminate'&&ops.operations[1].state==='interrupted_not_started','Restart classification wrong');
    await page.request.post(base+'/__fixture/release/prior');
    await page.locator('#review-recovery').click();
    await page.locator('#recovery-consent').waitFor({state:'visible'});
    check(await page.locator('#confirm-recovery').isDisabled(),'Unchecked consent enables recovery');
    check(posts===0&&sends===0,'Fresh review auto submitted');
    check((await page.locator('#recovery-status').textContent()).includes('Past effects remain unknown'),'Missing uncertain-effects acknowledgement');
    await page.locator('#acknowledge-recovery').check();
    await page.locator('#confirm-recovery').click();
    await page.waitForFunction(()=>document.querySelector('#notice').textContent.includes('Interrupted messages were not resent'));
    check(posts===1&&sends===0,'Confirmation retried or sent old work');
    check(await page.locator('#session-recovery').isHidden(),'Acknowledged lane still presented as paused');
    check((await page.locator('#saved-send-status').textContent()).includes('unknown'),'Past unknown result was relabelled as known');
    const after=await (await page.request.get(base+'/sessions/session_b/operations')).json();
    check(!after.recovery_required&&JSON.stringify(after.operations)===JSON.stringify(ops.operations),'Acknowledgement rewrote operation evidence');
    check(JSON.stringify(await (await page.request.get(base+'/sessions/session_b/history')).json())===JSON.stringify(history),'Acknowledgement changed canonical history');
    check((await (await page.request.get(base+'/__fixture/events')).json()).events.length===0,'Recovery spawned a writer');
    await page.reload();
    await page.waitForFunction(()=>document.querySelector('#session-directory').textContent==='session_b');
    await page.evaluate(async()=>{await syncOperations();});
    check(await page.locator('#session-recovery').isHidden(),'Browser reload lost server acknowledgement');
    check(posts===1&&sends===0,'Reload retried acknowledgement or old message');
    await page.locator('#message-input').fill('explicit recovery followup');
    await page.locator('#send-btn').click();
    let done=false;
    for(let attempt=0;attempt<150;attempt++){
        const {operations}=await(await page.request.get(base+'/sessions/session_b/operations')).json();
        if(operations.some(op=>op.message==='explicit recovery followup'&&op.state==='succeeded')){done=true;break;}
        await page.waitForTimeout(20);
    }
    check(done,'New explicit send did not finish');
    check(sends===1,'More than the one explicit new send was posted');
    const {events}=await(await page.request.get(base+'/__fixture/events')).json();
    check(events.filter(event=>event.kind==='start').length===1&&events[0].message==='explicit recovery followup','Old/queued work replayed');
    return {passed:true,checks:['held writer refused','GET review only','explicit checked confirmation','unchanged unknown evidence/history','reload without replay','new explicit send only']};
}

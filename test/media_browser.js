// Disposable tool/delivery_fixture.py on11018, CLI pins1(image) and2(10sWAV)
// published AFTER opening this page. No provider calls or live uploads.
async page => {
    const base='http://127.0.0.1:11018';
    if(!page.url().startsWith(base+'/'))throw Error('Use disposable fixture');
    const check=(value,message)=>{if(!value)throw Error(message);};
    await page.waitForFunction(()=>document.querySelector('#media-summary').textContent==='Pins (2)');
    await page.locator('#media-toggle').click();
    await page.waitForFunction(()=>document.querySelector('#media-items img')?.naturalWidth===1);
    check(await page.locator('#media-items audio').getAttribute('preload')==='none','Audio auto-preloads');
    await page.locator('#message-input').fill('draft stays');
    await page.evaluate(async()=>{window.mediaPlayer=document.querySelector('#media-items audio');await window.mediaPlayer.play();});
    await page.waitForFunction(()=>window.mediaPlayer.currentTime>.15);
    const time=await page.evaluate(()=>window.mediaPlayer.currentTime);
    const id='7'.repeat(32);
    const admit=await page.request.post(base+'/sessions/session_a/operations',{data:{request_id:id,message:'HOLD while publishing media'}});
    check(admit.status()===202,'Could not start offline held agent');
    let held=false;
    for(let attempt=0;attempt<250;attempt++){
        const {events}=await(await page.request.get(base+'/__fixture/events')).json();
        if(events.some(event=>event.kind==='start'&&event.message==='HOLD while publishing media')){held=true;break;}
        await page.waitForTimeout(20);
    }
    check(held,'Offline agent did not start');
    const history=await(await page.request.get(base+'/sessions/session_a/history')).json();
    const published=await page.evaluate(async()=>{
        window.mediaXSS=false;
        const canvas=document.createElement('canvas');canvas.width=2;canvas.height=2;
        canvas.getContext('2d').fillRect(0,0,2,2);
        const blob=await new Promise(resolve=>canvas.toBlob(resolve,'image/png'));
        const name='<img src=x onerror=window.mediaXSS=true>.png';
        const response=await fetch('/sessions/session_a/media/'+'3'.repeat(32)+'?filename='+encodeURIComponent(name),{method:'PUT',body:blob});
        return {status:response.status,body:await response.json()};
    });
    check(published.status===201,'Could not pin while agent owns execution fence');
    await page.waitForFunction(()=>document.querySelector('#media-summary').textContent==='Pins (3)');
    check(await page.evaluate(()=>document.querySelector('#media-items figure:first-child figcaption').textContent.startsWith('<img src=x')),'Newest pin is not first');
    check(await page.evaluate(()=>document.querySelector('#media-items audio')===window.mediaPlayer&&window.mediaPlayer.currentTime>0&&!window.mediaPlayer.paused),'Appending pin reset/replaced playing audio');
    check(await page.evaluate(()=>window.mediaPlayer.currentTime)>=time,'Playback position regressed');
    check(await page.evaluate(()=>document.activeElement.id==='message-input'&&document.querySelector('#message-input').value==='draft stays'),'Shelf stole focus/draft');
    check(await page.evaluate(()=>window.mediaXSS===false&&document.querySelectorAll('#media-items figcaption img').length===0),'Filename became executable markup');
    check(JSON.stringify(await(await page.request.get(base+'/sessions/session_a/history')).json())===JSON.stringify(history),'Publishing changed canonical chat history');
    check((await(await page.request.get(base+'/sessions/session_a/operations/'+id)).json()).operation.state==='running','Publishing stopped/advanced active agent');
    await page.evaluate(async()=>{await selectSession('session_b',false,false);});
    check(await page.evaluate(()=>window.mediaPlayer.paused&&!window.mediaPlayer.getAttribute('src')),'Navigation kept old audio active');
    await page.waitForFunction(()=>document.querySelector('#session-directory').textContent==='session_b');
    check(await page.locator('#media-items audio').count()===0,'Another session inherited media');
    check((await page.request.get(base+'/sessions/session_b/media/'+'1'.padStart(32,'0')+'/content')).status()===404,'Media ID escaped session identity');
    await page.evaluate(async()=>{await selectSession('session_a',false,false);});
    await page.waitForFunction(()=>document.querySelector('#media-summary').textContent==='Pins (3)');
    await page.reload();
    await page.waitForFunction(()=>document.querySelector('#media-summary').textContent==='Pins (3)');
    await page.locator('#media-toggle').click();
    check(await page.evaluate(()=>document.querySelector('#media-items audio').paused),'Reload auto-started audio');
    await page.setViewportSize({width:390,height:844});
    check(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth),'Media shelf overflows phone viewport');
    check(await page.locator('#media-items a[download]').count()===3,'Missing original download links');
    const first=await(await page.request.get(base+'/sessions/session_a/media/'+'1'.padStart(32,'0'))).json();
    const downloaded=await page.request.get(base+first.media.download_url);
    check(downloaded.status()===200&&downloaded.headers()['content-disposition'].startsWith('attachment;'),'Download unavailable after source cleanup/reload');
    await page.request.post(base+'/__fixture/release/normal');
    let finished=false;
    for(let attempt=0;attempt<250;attempt++){
        const {operation}=await(await page.request.get(base+'/sessions/session_a/operations/'+id)).json();
        if(operation.state==='succeeded'){finished=true;break;}
        await page.waitForTimeout(20);
    }
    check(finished,'Offline held agent did not finish');
    return {passed:true,checks:['CLI copies appear without reload','real image/audio playback','new pin preserves active player/time','publish during held agent','text-only filename','navigation stops audio/session isolation','reload/source-cleanup persistence','phone layout/downloads']};
}

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

async function controller(name) {
    const source = await readFile(new URL(`../src/ui/${name}.js`, import.meta.url), 'utf8');
    const end = source.indexOf("\nbyId('new-session-btn').addEventListener");
    assert.ok(end > 0);
    const context = vm.createContext({
        document: { getElementById: () => ({ value: '', addEventListener() {} }), addEventListener() {}, visibilityState: 'visible' },
        window: { matchMedia: () => ({ matches: false }), addEventListener() {} },
        AbortController, URLSearchParams, setTimeout, clearTimeout,
    });
    vm.runInContext(source.slice(0, end), context);
    vm.runInContext(`
        let warnings = 0;
        renderSessions = () => {}; showUnconfirmed = () => {}; notice = () => { warnings++; };
        sessions = [{id:'a'}, {id:'b'}, {id:'c'}]; currentSession = 'c';
        connected = true; historyReady = true; sendIdentityAvailable = true;
        function submission(id, text='same') { return {id, text, accepted:false, needsRecovery:false, settled:false}; }
    `, context);
    return code => vm.runInContext(code, context);
}

for (const name of ['follow', 'steady']) {
    test(`${name}: old backends stay single-flight and ordinary saturation still admits Stop`, async () => {
        const run = await controller(name);
        run(`
            currentSession='a';serverBusy.add('a');sendIdentityAvailable=false;updateInputState();
            if(!sendButton.disabled)throw Error('Concurrent UI activated without identity capability');
            sendIdentityAvailable=true;updateInputState();
            if(sendButton.disabled)throw Error('Server busy still blocked independent sends');
            const a=submission('a0'),b=submission('b0');
            activePosts.set(a.id,{sessionId:'a',request:a});activePosts.set(b.id,{sessionId:'b',request:b});
            input.value='followup';updateInputState();if(!sendButton.disabled)throw Error('Transport bound lost');
            input.value=' !stop ';checkingSnapshot=true;updateInputState();if(sendButton.disabled)throw Error('Healthy revalidation or ordinary transports blocked Stop');
            connected=false;updateInputState();if(!sendButton.disabled)throw Error('Stop bypassed connectivity guard');
        `);
    });

    test(`${name}: one terminal outcome cannot retire another same-text send`, async () => {
        const run = await controller(name);
        run(`
            const a = submission('a0'), b = submission('a1');
            addPending('a',a); addDisplay('a',a); addPending('a',b); addDisplay('a',b);
            if (!settleSend('a',a,{status:200,body:{reply:'done'}})) throw Error('Did not settle exact send');
            if (isPending('a',a) || !isPending('a',b) || pendingFor('a').length !== 1) throw Error('Sibling overwritten');
            if (displaySends.get('a').get(a.id) !== a) throw Error('Terminal delivery incorrectly proved canonical display');
            if (settleSend('a',a,{status:429,body:{detail:'late'}}) || warnings) throw Error('Late error changed completed send');
            settleSend('a',b,{status:429,body:{detail:'refused'}});
            if (pendingSends.has('a') || unconfirmedSends.get('a')[0] !== b || displaySends.get('a').has(b.id)) throw Error('Failure text not independently retained');
        `);
    });

    test(`${name}: pending and uncertain IDs all get receipt turns`, async () => {
        const run = await controller(name);
        await run(`(async () => {
            const a=submission('a0'), b=submission('a1'), c=submission('a2');
            addPending('a',a); addPending('a',b); unconfirmedSends.set('a',[c]);
            const calls=[];
            api=async path=>{const id=new URLSearchParams(path.split('?')[1]).get('request_id');calls.push(id);
                return {revision:'r',busy:true,send:{id,state:'missing'}};};
            await syncBackgroundReceipt(); await syncBackgroundReceipt(); await syncBackgroundReceipt();
            if (calls.join(',')!=='a0,a1,a2') throw Error('Receipt starvation: '+calls);
            reconcileReceipt('a',{tracked:a},{busy:true,send:{id:'a0',state:'running'}});
            if (!a.accepted || b.accepted || c.accepted) throw Error('Session busy leaked into another Send acknowledgement');
            if (deliveryStatus('a')!=='Unconfirmed') throw Error('Uncertainty was hidden');
        })()`);
    });

    test(`${name}: global transports and retained text leave a reserved stop slot`, async () => {
        const run = await controller(name);
        run(`
            const a=submission('a0'), b=submission('b0');
            addPending('a',a); addPending('b',b);
            activePosts.set(a.id,{sessionId:'a',request:a}); activePosts.set(b.id,{sessionId:'b',request:b});
            if (hasTransportCapacity('hello') || !hasTransportCapacity('  !stop  ')) throw Error('No stop transport reservation');
            settleSend('a',a,{status:200,body:{reply:'done'}});
            if (hasTransportCapacity('hello') || activePosts.size!==2) throw Error('Receipt alone released a held HTTP transport');
            if (!trackedFor('a').includes(a)) throw Error('Held transport escaped resource accounting');
            activePosts.delete(a.id);
            if (!hasTransportCapacity('hello')) throw Error('Actual HTTP finalization did not free a slot');
            const stop=submission('s0','!stop'); activePosts.set(stop.id,{sessionId:'c',request:stop});
            if (hasTransportCapacity('!stop')) throw Error('Multiple simultaneous control transports');
            activePosts.clear(); pendingSends.clear(); displaySends.clear();
            const saved=Array.from({length:16},(_,i)=>submission('saved'+i));
            unconfirmedSends.set('a',saved);
            if (hasSendCapacity('a','hello') || !hasSendCapacity('a','!stop')) throw Error('Retained uncertainty consumed stop reservation');
            addPending('a',submission('control','!stop'));
            if (hasSendCapacity('a','!stop') || unconfirmedSends.get('a').length!==16) throw Error('Overflow or silent eviction');
        `);
    });

    test(`${name}: dismissed records and unrelated receipts cannot resurrect sends`, async () => {
        const run = await controller(name);
        run(`
            const a=submission('a0'), b=submission('a1'); addPending('a',a); addPending('a',b);
            if (reconcileReceipt('a',{tracked:a},{send:{id:'a1',state:'complete',outcome:{status:200,body:{reply:'other'}}}})) throw Error('Wrong ID accepted');
            if (!isPending('a',a) || !isPending('a',b)) throw Error('Mismatch removed a send');
            removePending('a',a); preserveUnconfirmed('a',a); unconfirmedSends.delete('a');
            if (reconcileReceipt('a',{tracked:a},{send:{id:'a0',state:'complete',outcome:{status:429,body:{detail:'late'}}}})
                || a.failed || warnings || !isPending('a',b)) throw Error('Dismissal lost to late response');
        `);
    });
    test(`${name}: receipt-only completion retires display on the next unchanged snapshot`, async () => {
        const run = await controller(name);
        await run(`(async () => {
            currentSession='a';
            const send=submission('a0');addPending('a',send);addDisplay('a',send);
            historyCache.set('a',{revision:'same',history:[]});
            let draws=0;
            updateInputState=()=>{};connectionStatus=()=>{};chat.setAttribute=()=>{};
            renderHistory=(history,follow,finishedBefore)=>{draws++;if(finishedBefore.has(send.id))removeDisplay('a',send);};
            api=async()=>({revision:'same',busy:false,busy_sessions:[],send_identities:true,
                send:{id:'a0',state:'complete',outcome:{status:200,body:{reply:'done'}}}});
            await syncSnapshot();
            if(!send.settled || !displaySends.has('a') || draws!==1)throw Error('Completion was confused with history coverage');
            await syncSnapshot();
            if(displaySends.has('a') || draws!==2)throw Error('Unchanged history stranded a completed display record');
        })()`);
    });

    test(`${name}: removed-session text remains recoverable and explicit dismissal releases it`, async () => {
        const run = await controller(name);
        run(`
            const pending=submission('p'),uncertain=submission('u'),failed=submission('f'),done=submission('d');
            failed.failed=true;failed.settled=true;done.settled=true;
            let aborted=0;pending.transport={abort(){aborted++;}};
            addPending('gone',pending);addDisplay('gone',pending);addDisplay('gone',done);
            unconfirmedSends.set('gone',[uncertain,failed]);activePosts.set(pending.id,{sessionId:'gone',request:pending});
            recoverMissingSessions();
            const recovery=recoverableForView();
            if(pendingSends.has('gone') || displaySends.has('gone') || recovery.length!==3
                || !recovery.some(item=>item.request===pending) || !recovery.some(item=>item.request===failed))throw Error('Removed conversation lost text or retained completed display');
            dismissRecoverable(recovery);
            if(unconfirmedSends.has('gone') || aborted!==1 || isTracked('gone',pending))throw Error('Explicit recovery did not detach removed records');
            recoverMissingSessions();
            if(unconfirmedSends.has('gone'))throw Error('Dismissed text resurrected from a held transport');
            if(reconcileReceipt('gone',{tracked:pending},{send:{id:'p',state:'complete',outcome:{status:200,body:{reply:'late'}}}}))throw Error('Late removed response won over dismissal');
            activePosts.clear();
            if(trackedFor('gone').length || !hasSendCapacity('c','new'))throw Error('Removed records permanently consumed capacity');
        `);
    });
}

test('canonical optimistic coverage uses only unique explicit USER IDs; prefix ignores metadata', async () => {
    const source = await readFile(new URL('../src/ui/history-view.js', import.meta.url), 'utf8');
    const context = vm.createContext({ URL }); vm.runInContext(source, context);
    const helper = context.LimilinkHistory, id = 'a'.repeat(32);
    assert.equal(helper.version, 3);
    assert.equal(helper.canonicalSendIds([{role:'bot',content:'same',request_id:id}]).size, 0);
    assert.equal(helper.canonicalSendIds([{role:'user',content:'same',request_id:id}]).has(id), true);
    assert.equal(helper.canonicalSendIds([{role:'user',content:'same',request_id:id},{role:'user',content:'same',request_id:id}]).size, 0);
    assert.equal(helper.canonicalSendIds([{role:'user',content:'same',request_id:'bad'}]).size, 0);
    assert.equal(helper.isPrefix([{role:'user',content:'same'}],[{role:'user',content:'same',request_id:id}]), true);
});

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

async function controller(name) {
    const source = await readFile(new URL(`../src/ui/${name}.js`, import.meta.url), 'utf8');
    const end = source.indexOf("\nbyId('new-session-btn').addEventListener");
    const context = vm.createContext({
        document: { getElementById: () => ({ addEventListener() {} }), addEventListener() {}, visibilityState: 'visible' },
        window: { matchMedia: () => ({ matches: false }), addEventListener() {} },
        AbortController, URLSearchParams, setTimeout, clearTimeout,
    });
    vm.runInContext(source.slice(0, end), context);
    vm.runInContext(`
        let applied = [], renders = 0;
        renderSessions = () => { renders++; };
        replies = { observe(id, value) { applied.push([id, value]); return false; } };
        sessions = Array.from({length:21}, (_, i) => ({id:'session_' + i}));
        currentSession = 'session_0'; connected = true; historyReady = true; replyTrackingAvailable = true;
        serverBusy.add('session_0');
    `, context);
    return code => vm.runInContext(code, context);
}

for (const name of ['follow', 'steady']) {
    test(`${name}: bounded round-robin metadata batch does not alter history/activity/delivery`, async () => {
        const run = await controller(name);
        await run(`(async () => {
            const batches = [];
            api = async path => {
                if (!path.startsWith('/session-replies?')) throw Error('Wrong endpoint');
                const ids = new URLSearchParams(path.split('?')[1]).getAll('session_id');
                batches.push(ids);
                return {replies:Object.fromEntries(ids.map(id => [id, {state:'unknown'}]))};
            };
            await syncReplyBatch(); await syncReplyBatch(); await syncReplyBatch();
            if (batches.some(ids => ids.length >8 || ids.includes('session_0') || new Set(ids).size !== ids.length)) throw Error('Unbounded/duplicate/selected batch');
            if (new Set(batches.flat()).size !==20) throw Error('Rotation starved a known session');
            if (historyCache.size || pendingSends.size || !serverBusy.has('session_0') || !connected || !historyReady || renders) throw Error('Metadata crossed its ownership seam');
        })()`);
    });

    test(`${name}: coalescing, cancellation and hidden-page guards reject late metadata`, async () => {
        const run = await controller(name);
        await run(`(async () => {
            let calls = 0, release, signal;
            api = (path, options) => { calls++; signal=options.signal; return new Promise(resolve => {release=resolve;}); };
            const first=syncReplyBatch(), second=syncReplyBatch();
            if(calls!==1) throw Error('Not coalesced');
            pauseUpdates();
            if(!signal.aborted || activeReplyCheck!==null) throw Error('Pause did not cancel');
            release({replies:{session_1:{state:'known',token:'unused',index:0}}});
            if(await first || await second || applied.length) throw Error('Cancelled metadata applied');
            document.visibilityState='hidden';
            await syncReplyBatch();
            if(calls!==1) throw Error('Hidden page polled metadata');
        })()`);
    });

    test(`${name}: navigation/deletion and unexpected IDs cannot acknowledge selected replies`, async () => {
        const run = await controller(name);
        await run(`(async () => {
            let release;
            api=()=>new Promise(resolve=>{release=resolve;});
            const old=syncReplyBatch(); navigationVersion++; currentSession='session_1';
            release({replies:{session_1:{state:'known',token:'unused',index:0}}});
            if(await old || applied.length) throw Error('Navigation accepted old metadata');
            currentSession='session_0'; replyCursor=0;
            const next=syncReplyBatch();
            sessions=sessions.filter(item=>item.id!=='session_1');
            release({replies:{session_1:{state:'unknown'}, session_0:{state:'unknown'}, foreign:{state:'unknown'}}});
            await next;
            if(applied.some(([id])=>['session_0','session_1','foreign'].includes(id))) throw Error('Unowned/missing ID applied');
        })()`);
    });

    test(`${name}: unavailable/malformed reply seam never disconnects chat or replaces cursors`, async () => {
        const run = await controller(name);
        await run(`(async () => {
            let calls=0;
            api=async()=>{calls++;throw Error('old server or offline');};
            replyTrackingAvailable=false;
            await syncReplyBatch();
            if(calls) throw Error('Old backend was polled without reply capability');
            replyTrackingAvailable=true;
            if(await syncReplyBatch()) throw Error('Error accepted');
            api=async()=>({replies:null});
            if(await syncReplyBatch()) throw Error('Malformed payload accepted');
            if(applied.length || renders || !connected || !historyReady) throw Error('Failure mutated chat');
        })()`);
    });
}

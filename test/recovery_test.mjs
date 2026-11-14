import test from 'node:test';
import assert from 'node:assert/strict';
import {controller} from './delivery_controller.mjs';

const snapshot = {recovery_required:true,token:'a'.repeat(64),uncertain_ids:['b'.repeat(32)],
    configuration:{agent:'pi-a',model:'model-a',reasoning_effort:null},warning:'Past effects remain unknown. No interrupted work will be retried.'};
async function ready(c) {
    c.run("recoveryRequired.set('x',true); void reviewRecovery()"); await c.flush();
    c.calls.at(-1).respond(snapshot); await c.flush();
}

test('review is GET only and unchecked acknowledgement cannot POST; success never sends old work',async()=>{
    const c=await controller(); await ready(c);
    assert.equal(c.node('session-recovery').hidden,false);
    assert.match(c.node('recovery-status').textContent,/Past effects remain unknown/);
    c.run('void confirmRecovery()'); await c.flush();
    assert.equal(c.calls.length,1);
    c.node('acknowledge-recovery').checked=true;
    c.run('void confirmRecovery()'); await c.flush();
    const call=c.calls.at(-1);
    assert.equal(call.options.method,'POST'); assert.equal(call.path,'/sessions/x/recovery');
    assert.equal(call.body.acknowledge_possible_effects,true); assert.equal(call.body.token,snapshot.token);
    assert.match(call.body.request_id,/^[0-9a-f]{32}$/);
    call.respond({recovery_required:false,confirmation:{acknowledged:true}}); await c.flush();
    assert.equal(c.calls[2].options.method,undefined); // Read-only coverage observation.
    c.calls[2].respond({operations:[],recovery_required:false,recovery_acknowledged:[]}); await c.flush();
    assert.equal(c.node('session-recovery').hidden,true);
    assert.equal(c.calls.length,3);
    assert.match(c.node('notice').textContent,/not resent/);
});

test('only exact acknowledged revision permits a NEW click; unknown acceptance still blocks',async()=>{
    const c=await controller();
    const op={id:'b'.repeat(32),session_id:'x',sequence:1,revision:1,state:'indeterminate',message:'past unknown',execution_id:'old',outcome:{status:409,body:{detail:'unknown'}}};
    c.run(`applyOperation('x',${JSON.stringify(op)});`);
    await c.send('x','blocked before ack');
    assert.equal(c.calls.length,0);
    c.run(`readRecoveryAcknowledgements('x',${JSON.stringify({operations:[op],recovery_acknowledged:[{id:op.id,revision:1}]})})`);
    assert.equal(c.calls.length,0); // Acknowledgement itself does not pump anything.
    await c.send('x','new explicit intent');
    assert.equal(c.calls.length,1); assert.equal(c.calls[0].body.message,'new explicit intent');
    c.calls[0].respond({operation:{...op,id:c.calls[0].body.request_id,message:'new explicit intent',state:'succeeded',revision:2,outcome:{status:200,body:{reply:'ok'}}}}); await c.flush();
    c.run(`applyOperation('x',${JSON.stringify({...op,revision:2})});`);
    const count=c.calls.length;
    await c.send('x','blocked newer fault');
    assert.equal(c.calls.length,count);
    c.run(`readRecoveryAcknowledgements('x',${JSON.stringify({operations:[{...op,revision:2}],recovery_acknowledged:[{id:op.id,revision:2}]})}); ownOperation('x',{id:'c'.repeat(32),text:'lost acceptance',state:'unknown',revision:-1,attempted:true});`);
    await c.send('x','still blocked unknown acceptance');
    assert.equal(c.calls.length,count);
});

test('stale navigation cannot show or confirm another session review',async()=>{
    const c=await controller(); c.run("recoveryRequired.set('x',true); void reviewRecovery()"); await c.flush();
    c.run("currentSession='y'; navigationVersion++");
    c.calls[0].respond(snapshot); await c.flush();
    c.node('acknowledge-recovery').checked=true;
    c.run('void confirmRecovery()'); await c.flush();
    assert.equal(c.calls.length,1);
    assert.equal(c.node('session-recovery').hidden,true);
});

test('lost acknowledgement response consumes review and never auto retries or sends',async()=>{
    const c=await controller(); await ready(c);
    c.node('acknowledge-recovery').checked=true;
    c.run('void confirmRecovery()'); await c.flush();
    c.calls[1].reject(Error('lost response')); await c.flush();
    assert.match(c.node('recovery-status').textContent,/Review again/);
    assert.equal(c.node('confirm-recovery').hidden,true);
    c.node('acknowledge-recovery').checked=true; c.run('void confirmRecovery()'); await c.flush();
    assert.equal(c.calls.length,2);
    c.run('void reviewRecovery()'); await c.flush();
    assert.notEqual(c.calls[2].options.method,'POST');
    c.calls[2].respond({recovery_required:false}); await c.flush();
    assert.equal(c.node('session-recovery').hidden,true);
});

test('discovery does not require an uncertain record inside the terminal window',async()=>{
    const c=await controller(); c.run('void syncOperations()'); await c.flush();
    c.calls[0].respond({operations:[],recovery_required:true}); await c.flush();
    assert.equal(c.node('session-recovery').hidden,false);
    assert.equal(c.calls.length,1);
});

test('listing failure still offers an explicit review route without inventing readiness',async()=>{
    const c=await controller(); c.run('void syncOperations()'); await c.flush();
    c.calls[0].respond({detail:'receipt unreadable'},409); await c.flush();
    assert.equal(c.node('session-recovery').hidden,false);
    assert.match(c.node('recovery-status').textContent,/unavailable/);
    assert.equal(c.node('confirm-recovery').hidden,true);
    assert.equal(c.calls.length,1);
});

test('ack receipt with a newer pause stays visibly paused',async()=>{
    const c=await controller(); await ready(c);
    c.node('acknowledge-recovery').checked=true;
    c.run('void confirmRecovery()'); await c.flush();
    c.calls[1].respond({recovery_required:true,confirmation:{acknowledged:true}}); await c.flush();
    assert.equal(c.node('session-recovery').hidden,false);
    assert.match(c.node('notice').textContent,/still paused/);
    assert.equal(c.calls.length,2);
});

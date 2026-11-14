import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,symlinkSync,chmodSync,rmSync,mkdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {createRoleBindings,roleFacts} from '../tool/activity-bindings.mjs';
import {keyedIdFor} from '../tool/activity-metadata.mjs';

function fixture(t, options={}) {
    const directory=mkdtempSync(join(tmpdir(),'activity-bindings-'));
    t.after(()=>rmSync(directory,{recursive:true,force:true}));
    const config={token:randomUUID(),file:'/PRIVATE/parent.jsonl',uuid:'parent-uuid'};
    let clock=10000;
    const bindings=createRoleBindings(config,{now:()=>clock,...options});
    const result=(rows,runId='run')=>({toolName:'subagent',partialResult:{details:{runId,results:rows}}});
    const run=(id='async',owner=config.file)=>{
        const dir=join(directory,id);mkdirSync(dir,{mode:0o700});
        const status={lifecycleArtifactVersion:3,runId:id,sessionId:owner,state:'running',
            steps:[{agent:'specialist',sessionFile:'/PRIVATE/child.jsonl'}]};
        const write=()=>writeFileSync(join(dir,'status.json'),JSON.stringify(status),{mode:0o600});write();
        return {dir,status,write,start:()=>bindings.started({id,sessionId:owner,asyncDir:dir})};
    };
    return {directory,config,bindings,result,run,advance:()=>clock+=1000};
}

test('explicit foreground run/index and file evidence, never result position, names or arguments',t=>{
    const f=fixture(t);
    f.bindings.tool(f.result([{index:3,agent:'staff',sessionFile:'/PRIVATE/b.jsonl'},
        {index:1,agent:'specialist',sessionFile:'/PRIVATE/a.jsonl'}, {index:9,agent:'trainee'}]),true);
    let facts=f.bindings.snapshot();assert.equal(facts.bindings.length,2);
    assert.deepEqual(facts.bindings.map(row=>row.agent),['staff','specialist']);
    f.bindings.tool(f.result([{index:1,agent:'specialist',sessionFile:'/PRIVATE/a.jsonl'}]),true);
    assert.equal(f.bindings.snapshot().bindings.length,2);
    const event={toolName:'read'};Object.defineProperty(event,'result',{get(){throw Error('General result read');}});
    f.bindings.tool(event);
    f.bindings.tool(f.result([{index:0,agent:'worker',sessionFile:'relative'},
        {index:1,agent:'../private',sessionFile:'/PRIVATE/c.jsonl'}]),true);
    assert.equal(f.bindings.snapshot().bindings.length,2);
    assert.ok(!JSON.stringify(facts).includes('PRIVATE'));
    const restored=createRoleBindings(f.config,{initial:facts});
    assert.deepEqual(restored.snapshot(),facts);
});

test('contradictory stable tuple invalidates both targets; overflow fails closed',t=>{
    const f=fixture(t,{limit:3});
    f.bindings.tool(f.result([{index:0,agent:'staff',sessionFile:'/a'}]),true);
    f.bindings.tool(f.result([{index:0,agent:'specialist',sessionFile:'/b'}]),true);
    assert.ok(f.bindings.snapshot().bindings.every(row=>row.agent===null));
    f.bindings.tool(f.result([{index:1,agent:'staff',sessionFile:'/c'},{index:2,agent:'staff',sessionFile:'/d'}]),true);
    assert.deepEqual(f.bindings.snapshot(),{bindings:[],bindingsLimited:true});
});

test('oversized foreground and owned background arrays suppress previous roles instead of retaining a winner',t=>{
    const a=fixture(t);a.bindings.tool(a.result([{index:0,agent:'staff',sessionFile:'/target'}]),true);
    a.bindings.tool(a.result(Array.from({length:65},(_,index)=>({index,agent:'specialist',sessionFile:'/target'}))),true);
    assert.deepEqual(a.bindings.snapshot(),{bindings:[],bindingsLimited:true});
    const b=fixture(t),run=b.run();run.start();assert.equal(b.bindings.snapshot().bindings.length,1);
    run.status.steps=Array.from({length:65},()=>({agent:'staff',sessionFile:'/PRIVATE/child.jsonl'}));run.write();b.advance();
    assert.deepEqual(b.bindings.snapshot(),{bindings:[],bindingsLimited:true});
});

test('background roles read only explicitly announced runs belonging to this exact parent',t=>{
    const f=fixture(t),run=f.run(),foreign=f.run('foreign','other-parent');
    foreign.start();assert.equal(f.bindings.snapshot().bindings.length,0);
    f.advance();run.start();let facts=f.bindings.snapshot();
    assert.equal(facts.bindings.length,1);assert.equal(facts.bindings[0].agent,'specialist');
    assert.equal(facts.bindings[0].fileKey,keyedIdFor(f.config.token,'file','/PRIVATE/child.jsonl'));
    run.status.steps.push({agent:'staff',sessionFile:'/PRIVATE/second.jsonl',workflowKey:'implementation'});run.write();f.advance();
    facts=f.bindings.snapshot();assert.equal(facts.bindings.length,2);
    assert.ok(!JSON.stringify(facts).includes('PRIVATE'));
    assert.ok(!JSON.stringify(facts).includes(run.dir));
});

test('an originating async receipt admits status without an event; foreign/changed run ids add nothing',t=>{
    const f=fixture(t),run=f.run();
    f.bindings.tool({toolName:'subagent',result:{details:{asyncId:'async',asyncDir:run.dir}}});
    assert.equal(f.bindings.snapshot().bindings.length,1);
    run.status.runId='different';run.status.steps.push({agent:'staff',sessionFile:'/PRIVATE/not-owned'});run.write();f.advance();
    assert.equal(f.bindings.snapshot().bindings.length,1);
    run.status.runId='async';run.status.sessionId='foreign';run.write();f.advance();
    assert.equal(f.bindings.snapshot().bindings.length,1);
});

test('status symlinks, writable/oversized files and missing discovery never yield role evidence',t=>{
    const f=fixture(t),run=f.run();
    const path=join(run.dir,'status.json');
    const elsewhere=join(f.directory,'elsewhere.json');writeFileSync(elsewhere,JSON.stringify(run.status));
    rmSync(path);symlinkSync(elsewhere,path);run.start();
    assert.equal(f.bindings.snapshot().bindings.length,0);
    rmSync(path);run.write();chmodSync(path,0o666);f.advance();
    assert.equal(f.bindings.snapshot().bindings.length,0);
    chmodSync(path,0o600);writeFileSync(path,' '.repeat(256*1024+1));f.advance();
    assert.equal(f.bindings.snapshot().bindings.length,0);
    const unannounced=f.run('unannounced');unannounced.write();f.advance();
    assert.equal(f.bindings.snapshot().bindings.length,0);
    assert.equal(roleFacts([{id:'fake',fileKey:'fake',agent:'staff'}],16),null);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
import {controller} from './delivery_controller.mjs';

async function shelf() {
    class Node {
        constructor(tag) { this.tag=tag;this.children=[];this.hidden=true;this.open=false;this.textContent='';this.appendCalls=0;this.currentTime=0;this.pauses=0;this.loads=0; }
        append(...nodes) { this.appendCalls++; for(const node of nodes){node.parent=this;this.children.push(node);} }
        insertBefore(node, next) { this.appendCalls++; node.parent=this; const index=this.children.indexOf(next); this.children.splice(index<0?this.children.length:index,0,node); }
        replaceChildren(...nodes) { this.children=[];this.append(...nodes); }
        addEventListener(type, callback){this['on'+type]=callback;}
        setAttribute(key,value){this[key]=value;}
        focus(){document.activeElement=this;}
        remove() { if(this.parent)this.parent.children=this.parent.children.filter(node=>node!==this); }
        removeAttribute(key){delete this[key];}
        pause(){this.pauses++;}
        load(){this.loads++;this.currentTime=0;}
        set innerHTML(_){throw Error('untrusted HTML rendering');}
    }
    const nodes=new Map(), calls=[], timers=new Map(); let timer=0;
    const node=id=>{if(!nodes.has(id))nodes.set(id,new Node(id));return nodes.get(id);};
    const events=[];
    const document={visibilityState:'visible',getElementById:node,createElement:tag=>new Node(tag),dispatchEvent:event=>events.push(event)};
    const overlay={matches:false};
    const confirms=[];
    const context=vm.createContext({document,currentSession:'x',AbortController,
        confirm:message=>{confirms.push(message);return context.acceptRemoval !== false;},
        matchMedia:()=>overlay,mobile:{matches:false},app:{classList:{contains:()=>false}},
        CustomEvent:class {constructor(type,options){this.type=type;this.detail=options.detail;}},

        setTimeout:callback=>{timers.set(++timer,callback);return timer;},clearTimeout:id=>timers.delete(id),
        fetch:(path,options)=>new Promise((resolve,reject)=>calls.push({path,options,reject,
            respond:(data,status=200)=>resolve({ok:status<400,json:async()=>data})})),
    });
    const source=await readFile(new URL('../src/ui/media.js',import.meta.url),'utf8');
    vm.runInContext(source.slice(0,source.indexOf('const sessionMediaShelf =')),context);
    const run=code=>vm.runInContext(code,context);
    run('shelf = new SessionMediaShelf(); shelf.changed();');
    const flush=async()=>{for(let i=0;i<12;i++)await Promise.resolve();};
    return {node,calls,run,flush,timers,document,overlay,events,confirms};
}
function item(id='1',sid='x',extra={}) {
    id=id.repeat(32);
    return {version:1,id,session_id:sid,name:'voice.wav',mime:'audio/wav',size:100,sha256:'a'.repeat(64),created_at:1,
        url:`/sessions/${sid}/media/${id}/content`,download_url:`/sessions/${sid}/media/${id}/content?download=1`,...extra};
}
const snapshot=(items,revision='a')=>({media:items,revision:revision.repeat(64)});

test('broad liveness never claims thinking or gates Send; exact delivery labels win',async()=>{
    const c=await controller();
    c.run("serverBusy.add('x'); updateInputState();");
    assert.equal(c.node('typing').textContent,'Session busy…');assert.equal(c.node('send-btn').disabled,false);
    c.run("ownOperation('x',{id:'1'.repeat(32),text:'hello',state:'queued',revision:0,attempted:true});updateInputState();");
    assert.equal(c.node('typing').textContent,'Queued');
    c.run("trackedFor('x')[0].state='running';updateInputState();");assert.equal(c.node('typing').textContent,'Running');
    c.run("trackedFor('x')[0].state='indeterminate';updateInputState();");assert.equal(c.node('typing').textContent,'Effects unknown');
    c.run("trackedFor('x')[0].state='sending';updateInputState();");assert.equal(c.node('typing').textContent,'Sending…');
    c.run("trackedFor('x')[0].state='failed';updateInputState();");assert.equal(c.node('typing').textContent,'Session busy…');
    c.run("serverBusy.clear();operations.clear();updateInputState();");assert.equal(c.node('typing').hidden,true);
    assert.equal(c.calls.length,0);
});

test('unchanged and appended pins preserve the same playing audio node without moving it',async()=>{
    const c=await shelf();c.calls[0].respond(snapshot([item()]));await c.flush();
    const player=c.run("shelf.cards.get('1'.repeat(32)).player");player.currentTime=23;
    const appends=c.node('media-items').appendCalls;
    c.run('void shelf.refresh()');c.calls[1].respond({unchanged:true,revision:'a'.repeat(64)});await c.flush();
    assert.equal(c.run("shelf.cards.get('1'.repeat(32)).player"),player);
    assert.equal(player.currentTime,23);assert.equal(c.node('media-items').appendCalls,appends);
    c.run('void shelf.refresh()');c.calls[2].respond(snapshot([item(),item('2','x',{mime:'image/png',name:'picture.png'})],'b'));await c.flush();
    assert.equal(c.run("shelf.cards.get('1'.repeat(32)).player"),player);
    assert.equal(player.currentTime,23);assert.equal(c.node('media-items').appendCalls,appends+1);
    assert.equal(player.preload,'none');assert.equal(player.autoplay,undefined);
    assert.equal(c.calls.every(call=>call.options.method===undefined),true);
});

test('pins are newest first, including equal timestamps and late-arriving older pins',async()=>{
    const c=await shelf();
    c.calls[0].respond(snapshot([item('1','x',{created_at:3}),item('2','x',{created_at:1}),item('3','x',{created_at:3})]));await c.flush();
    const names=()=>c.node('media-items').children.map(node=>[...c.run('shelf.cards.values()')].find(card=>card.node===node).item.id[0]);
    assert.deepEqual(names(),['3','1','2']);
    const players=c.run('[...shelf.cards.values()].map(card=>card.player)');players.forEach(player=>player.currentTime=17);
    c.run('void shelf.refresh()');
    c.calls[1].respond(snapshot([item('4','x',{created_at:2}),item('2','x',{created_at:1}),item('5','x',{created_at:4}),item('3','x',{created_at:3}),item('1','x',{created_at:3})],'b'));await c.flush();
    assert.deepEqual(names(),['5','3','1','4','2']);
    assert.ok(players.every(player=>player.currentTime===17&&player.pauses===0&&player.loads===0));
});

test('Pins opens explicitly, traps the background on mobile, and restores focus when closed',async()=>{
    const c=await shelf();c.calls[0].respond(snapshot([]));await c.flush();
    assert.equal(c.node('session-media').hidden,true);
    assert.equal(c.node('media-toggle').textContent,'Pins (0)');
    c.overlay.matches=true;c.run('shelf.setOpen(true)');
    assert.equal(c.node('session-media').hidden,false);
    assert.equal(c.node('session-media')['aria-modal'],'true');
    assert.equal(c.node('conversation').inert,true);
    assert.equal(c.node('media-backdrop').hidden,false);
    assert.equal(c.document.activeElement,c.node('media-close'));
    assert.equal(c.events[0].detail,'pins');
    c.run('shelf.setOpen(false)');
    assert.equal(c.node('conversation').inert,false);
    assert.equal(c.node('session-media').hidden,true);
    assert.equal(c.document.activeElement,c.node('media-toggle'));
});

test('A→B→A rejects old responses and navigation stops previous playback',async()=>{
    const c=await shelf();const old=c.calls[0];
    c.run("currentSession='y';shelf.changed()");const other=c.calls[1];
    c.run("currentSession='x';shelf.changed()");c.calls[2].respond(snapshot([item('3')],'c'));await c.flush();
    old.respond(snapshot([item('1')],'a'));other.respond(snapshot([item('2','y')],'b'));await c.flush();
    assert.equal(c.run('shelf.cards.size'),1);assert.equal(c.run("shelf.cards.has('3'.repeat(32))"),true);
    const player=c.run("shelf.cards.get('3'.repeat(32)).player");
    c.run("currentSession='y';shelf.changed()");
    assert.equal(player.pauses,1);assert.equal(player.loads,1);assert.equal(player.src,undefined);
});

test('shelf errors preserve known media, draft and Send independence',async()=>{
    const c=await shelf();c.node('send-btn').disabled=false;c.node('message-input').value='keep draft';
    c.calls[0].respond(snapshot([item()]));await c.flush();const player=c.run("shelf.cards.get('1'.repeat(32)).player");
    c.run('void shelf.refresh()');c.calls[1].respond({detail:'not available'},409);await c.flush();
    assert.equal(c.run("shelf.cards.get('1'.repeat(32)).player"),player);
    assert.match(c.node('media-status').textContent,/Existing pins were not cleared/);
    assert.equal(c.node('message-input').value,'keep draft');assert.equal(c.node('send-btn').disabled,false);
});

test('untrusted filenames are text and external/cross-session URLs are refused',async()=>{
    const c=await shelf();const name='<img src=x onerror=alert(1)>.wav';
    c.calls[0].respond(snapshot([item('1','x',{name})]));await c.flush();
    const card=c.run("shelf.cards.get('1'.repeat(32))");
    assert.ok(card.node.children.some(node=>node.tag==='figcaption'&&node.textContent.includes(name)));
    c.run('void shelf.refresh()');c.calls[1].respond(snapshot([item('2','x',{url:'https://example.invalid/private'})],'b'));await c.flush();
    assert.equal(c.run('shelf.cards.size'),1);assert.match(c.node('media-status').textContent,/Incomplete/);
});

test('display-name limit counts Unicode code points like the server',async()=>{
    const c=await shelf();const name='🎵'.repeat(80)+'.wav';
    c.calls[0].respond(snapshot([item('1','x',{name})]));await c.flush();
    assert.equal(c.run('shelf.cards.size'),1);
    assert.equal(c.run("shelf.cards.get('1'.repeat(32)).item.name"),name);
});

test('removal requires confirmation, stops only that audio and refreshes the count',async()=>{
    const c=await shelf();c.calls[0].respond(snapshot([item(),item('2')]));await c.flush();
    const card=c.run("shelf.cards.get('1'.repeat(32))");
    const other=c.run("shelf.cards.get('2'.repeat(32))");other.player.currentTime=19;
    c.run("acceptRemoval=false");card.remove.onclick();await c.flush();
    assert.equal(c.calls.length,1);assert.equal(c.run('shelf.cards.size'),2);
    c.run("acceptRemoval=true");card.remove.focus();card.remove.onclick();card.remove.onclick();
    assert.equal(c.calls.length,2);assert.equal(card.remove.disabled,true);
    assert.equal(c.calls[1].options.method,'DELETE');
    assert.equal(c.calls[1].path,'/sessions/x/media/'+'1'.repeat(32));
    c.calls[1].respond(null,204);await c.flush();
    assert.equal(c.run('shelf.cards.size'),1);assert.equal(card.player.pauses,1);
    assert.equal(other.player.currentTime,19);assert.equal(other.player.pauses,0);
    assert.equal(c.node('media-toggle').textContent,'Pins (1)');
    assert.equal(c.document.activeElement,c.node('media-close'));
    c.calls[2].respond(snapshot([item('2')],'b'));await c.flush();
    assert.equal(c.run('shelf.revision'),'b'.repeat(64));
});

test('removal failures keep the pin; stale listings and navigation cannot restore it',async()=>{
    const c=await shelf();c.calls[0].respond(snapshot([item()]));await c.flush();
    const card=c.run("shelf.cards.get('1'.repeat(32))");
    card.remove.onclick();c.calls[1].respond({detail:'busy'},409);await c.flush();
    assert.equal(c.run('shelf.cards.size'),1);assert.equal(card.remove.disabled,false);
    assert.match(c.node('media-status').textContent,/Removal not confirmed: busy/);
    c.run('void shelf.refresh()');const stale=c.calls[2];
    card.remove.onclick();c.calls[3].respond(null,204);await c.flush();
    stale.respond(snapshot([item()]));await c.flush();
    assert.equal(c.run('shelf.cards.size'),0);
    c.calls[4].respond(snapshot([item('2')],'b'));await c.flush();
    c.run("shelf.cards.get('2'.repeat(32)).remove.onclick(); currentSession='y';shelf.changed();currentSession='x';shelf.changed();");
    c.calls[7].respond(snapshot([item('3')],'c'));await c.flush();
    c.calls[5].respond(null,204);await c.flush();
    assert.equal(c.run("shelf.cards.has('3'.repeat(32))"),true);
    assert.equal(c.calls.length,8);
});

test('hidden pages do not poll; timeout changes only the shelf status',async()=>{
    const c=await shelf();c.calls[0].respond(snapshot([]));await c.flush();
    c.document.visibilityState='hidden';c.run('void shelf.refresh()');assert.equal(c.calls.length,1);
    c.document.visibilityState='visible';c.run('void shelf.refresh()');
    [...c.timers.values()][0]();c.calls[1].reject(Error('aborted'));await c.flush();
    assert.match(c.node('media-status').textContent,/timed out/);
    assert.equal(c.node('session-media').hidden,true, 'Polling failures must not open the panel');
});

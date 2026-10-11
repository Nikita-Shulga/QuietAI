'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {DismissedWork,inspect,valid}=require('../../desktop/dismissed-work');
const {item,snapshot}=require('./dismissal-fixtures.cjs');
function dismiss(d,s,provider='Codex',session='one'){d.dismiss(s,provider,session,inspect(s,provider,session).token);return d.apply(s);}
test('strictly valid fixture and root dismissal leave original tracker records intact',()=>{
 const s=snapshot(),before=JSON.stringify(s),d=new DismissedWork();assert.equal(valid(s),true);const result=dismiss(d,s);assert.equal(result.clear,true);assert.equal(result.running,0);assert.equal(result.chatCount,0);assert.equal(d.count,1);assert.equal(JSON.stringify(s),before);assert.equal(s.work.length,1);
});
test('all current root prompts in one session dismissed; another session/provider unaffected',()=>{
 const s=snapshot([item(),item('Codex','one','second'),item('Codex','two'),item('Claude','one')]),d=new DismissedWork(),r=dismiss(d,s);assert.equal(r.running,2);assert.equal(r.chatCount,2);assert.equal(r.clear,false);assert.deepEqual(r.work.map(w=>w.provider+':'+w.session),['Codex:two','Claude:one']);
});
for(const [name,extra] of [['background',{isBackground:true}],['scheduled',{status:'Scheduled'}],['uncertain',{status:'Uncertain'}]])test(`${name} work still blocks after selected roots dismissed`,()=>{
 const s=snapshot([item(),item('Codex','one','other',extra)]),d=new DismissedWork(),r=dismiss(d,s);assert.equal(r.clear,false);assert.equal(r.work.length,1);assert.equal(r.work[0].key,'other');
});
for(const [name,change] of [['source append',w=>w.activityToken='generation:2'],['new event timestamp',w=>w.lastEventUtc='2026-10-11T12:00:01Z'],['same-key new activity',w=>w.activityToken='live:busy:2'],['status/meaning change',w=>w.reason='Waiting for input']])test(`${name} restores existing-key root before clear can be inferred`,()=>{
 const s=snapshot(),d=new DismissedWork();dismiss(d,s);const w={...s.work[0]};change(w);const r=d.apply(snapshot([w]));assert.equal(r.clear,false);assert.equal(r.running,1);assert.equal(d.count,0);
});
test('new prompt, completion and deletion do not inherit session dismissal',()=>{
 for(const items of [[item(),item('Codex','one','new-prompt')],[],[item('Codex','one','next-prompt')]]){const d=new DismissedWork(),s=snapshot();dismiss(d,s);const r=d.apply(snapshot(items));assert.equal(d.count,0);assert.equal(r.work.length,items.length);}
});
test('a new process/restart retains no dismissals; restore restores all without tracker mutation',()=>{
 const s=snapshot(),d=new DismissedWork();dismiss(d,s);assert.equal(new DismissedWork().apply(s).clear,false);assert.equal(d.restore(),1);assert.equal(d.apply(s).clear,false);assert.equal(d.count,0);
});
test('mismatched token, missing activity metadata and window-only rows refuse dismissal',()=>{
 const s=snapshot(),d=new DismissedWork();assert.throws(()=>d.dismiss(s,'Codex','one','forged'));const old=snapshot([item('Codex','one',undefined,{activityToken:''})]);assert.equal(inspect(old,'Codex','one'),null);old.codex.chats[0].fromWindow=true;assert.equal(inspect(old,'Codex','one'),null);
});
for(const [name,mutate] of [['unknown status',s=>s.codex.work[0].status='Maybe'],['partial counts',s=>delete s.running],['disconnected provider',s=>{s.codex.connected=false;}],['count contradiction',s=>s.codex.running=0],['flat mismatch',s=>s.work=[]],['unknown work flags',s=>delete s.codex.work[0].isBackground],['unknown chat',s=>s.codex.chats[0].promptCount=99]])test(`${name} cannot hide uncertain activity`,()=>{
 const d=new DismissedWork(),s=snapshot();dismiss(d,s);mutate(s);assert.equal(inspect(s,'Codex','one'),null);const r=d.apply(s);assert.equal(d.count,0);assert.equal(r.clear,false);assert.equal(r.codex.work.length,1);
});
test('disabled/disconnected provider never becomes connected via manual override',()=>{
 const d=new DismissedWork(),s=snapshot();dismiss(d,s);const other=snapshot([item('Claude','other',undefined,{status:'Uncertain'})]);other.codex.enabled=false;other.codex.clear=true;other.claude.connected=false;other.clear=false;assert.equal(d.apply(other).clear,false);assert.equal(d.count,0);
});

test('ordinary unchanged rescans preserve dismissal without mutating raw work',()=>{const s=snapshot(),d=new DismissedWork();dismiss(d,s);for(let i=0;i<5;i++){const next=structuredClone(s);next.checkedUtc='2026-10-11T12:00:0'+i+'Z';next.revision=i+2;const r=d.apply(next);assert.equal(r.clear,true);assert.equal(r.chatCount,0);assert.equal(d.count,1);assert.equal(next.work.length,1);}});

test('duplicate flat records or unpaired chat sessions are invalid snapshots',()=>{for(const mutate of [s=>s.work=[s.work[0],s.work[0]],s=>s.chats=[s.chats[0],s.chats[0]],s=>{delete s.codex.chats[0].session;delete s.codex.chats[0].promptCount;}]){const s=snapshot([item(),item('Codex','two')]);mutate(s);assert.equal(valid(s),false);assert.equal(inspect(s,'Codex','one'),null);}});

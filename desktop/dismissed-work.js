'use strict';
// App-session-only, explicit overrides. Raw tracker records are never excluded,
// changed or deleted: every scan can rediscover new activity. No process APIs.
const {createHash}=require('node:crypto');
const providers=['codex','claude'];
const identity=(provider,session)=>JSON.stringify([provider,session]);
const root=item=>item.status==='Running'&&item.isBackground===false;
const statuses=new Set(['Running','Scheduled','Uncertain']);
const count=(items,status)=>items.filter(item=>item.status===status).length;
function valid(snapshot){
  if(!snapshot||!Array.isArray(snapshot.work)||!Array.isArray(snapshot.chats)||!Number.isFinite(Date.parse(snapshot.checkedUtc)))return false;
  const keys=new Set();
  for(const key of providers){
    const p=snapshot[key],name=key==='codex'?'Codex':'Claude';
    if(!p||typeof p.enabled!=='boolean'||typeof p.connected!=='boolean'||!Array.isArray(p.work)||!Array.isArray(p.chats))return false;
    for(const w of p.work){
      if(!w||typeof w.key!=='string'||!w.key||keys.has(w.key)||w.provider!==name||typeof w.session!=='string'||!statuses.has(w.status)||typeof w.isBackground!=='boolean')return false;
      keys.add(w.key);
    }
    if(p.running!==count(p.work,'Running')||p.scheduled!==count(p.work,'Scheduled')||p.uncertain!==count(p.work,'Uncertain')||p.backgroundRunning!==p.work.filter(w=>w.status==='Running'&&w.isBackground).length||p.chatCount!==p.chats.length)return false;
    const roots=new Map();for(const w of p.work.filter(root))roots.set(w.session,(roots.get(w.session)||0)+1);
    if(roots.size!==p.chats.length)return false;
    const sessions=new Set();
    for(const c of p.chats){if(!c||c.fromWindow||c.provider!==name||typeof c.session!=='string'||!roots.has(c.session)||sessions.has(c.session)||c.promptCount!==roots.get(c.session)||typeof c.title!=='string')return false;sessions.add(c.session);}
    if(p.clear!==(!p.enabled||(p.connected&&p.work.length===0)))return false;
  }
  const work=providers.flatMap(k=>snapshot[k].work),chats=providers.flatMap(k=>snapshot[k].chats);
  // A malformed/partial/unknown tracker snapshot must never be made clear.
  const byKey=new Map(work.map(w=>[w.key,JSON.stringify(w)])),byChat=new Map(chats.map(c=>[identity(c.provider,c.session),JSON.stringify(c)]));
  if(new Set(snapshot.work.map(w=>w?.key)).size!==snapshot.work.length||new Set(snapshot.chats.map(c=>identity(c?.provider,c?.session))).size!==snapshot.chats.length||snapshot.work.length!==work.length||snapshot.work.some(w=>!w||byKey.get(w.key)!==JSON.stringify(w))||snapshot.chats.length!==chats.length||snapshot.chats.some(c=>!c||byChat.get(identity(c.provider,c.session))!==JSON.stringify(c)))return false;
  for(const name of ['running','scheduled','uncertain','backgroundRunning','chatCount'])if(snapshot[name]!==providers.reduce((n,k)=>n+snapshot[k][name],0))return false;
  return snapshot.clear===(snapshot.codex.clear&&snapshot.claude.clear&&(snapshot.codex.enabled||snapshot.claude.enabled));
}
function describe(snapshot,provider,session){
  if(!['Codex','Claude'].includes(provider)||typeof session!=='string'||!session)return null;
  const p=snapshot[provider==='Codex'?'codex':'claude'];if(!p.enabled||!p.connected)return null;
  const chat=p.chats.find(c=>c.session===session),items=p.work.filter(w=>w.session===session&&root(w));
  if(!chat||!items.length||items.some(w=>typeof w.activityToken!=='string'||!w.activityToken||w.activityToken.length>4096||!Number.isFinite(Date.parse(w.lastEventUtc))))return null;
  const token=createHash('sha256').update(JSON.stringify([provider,session,items.map(w=>[w.key,w.activityToken,w.lastEventUtc,w.reason]).sort((a,b)=>a[0].localeCompare(b[0]))])).digest('hex');
  return{provider,session,title:chat.title,promptCount:items.length,keys:items.map(w=>w.key),token};
}
function inspect(snapshot,provider,session){return valid(snapshot)?describe(snapshot,provider,session):null;}
class DismissedWork{
  constructor(){this.entries=new Map();this.version=0;}
  get count(){return this.entries.size;}
  dismiss(snapshot,provider,session,token){
    const now=inspect(snapshot,provider,session);
    if(!now||now.token!==token)throw new Error('This entry changed or cannot be verified. Review its current activity and try again.');
    const id=identity(provider,session);if(this.entries.has(id))throw new Error('This entry is already dismissed.');
    this.entries.set(id,now);this.version++;return now;
  }
  restore(){const n=this.count;if(n){this.entries.clear();this.version++;}return n;}
  apply(snapshot){
    const eligible=valid(snapshot),removed=new Set();
    for(const [id,entry] of this.entries){
      const now=eligible?describe(snapshot,entry.provider,entry.session):null;
      if(!now||now.token!==entry.token){this.entries.delete(id);this.version++;}
      else for(const key of entry.keys)removed.add(key);
    }
    if(!snapshot)return snapshot;
    const result={...snapshot,revision:String(snapshot.revision)+'/manual:'+this.version};
    for(const key of providers){
      const p=snapshot[key];if(!p)continue;
      const gone=eligible?p.work.filter(w=>removed.has(w.key)):[];
      const work=gone.length?p.work.filter(w=>!removed.has(w.key)):p.work;
      const chats=(p.chats||[]).filter(c=>!this.entries.has(identity(c.provider,c.session))).map(c=>{
        const entry=eligible?describe(snapshot,c.provider,c.session):null;
        return{...c,dismissToken:entry?.token||'',dismissible:!!entry,dismissReason:entry?'':'This activity cannot be safely dismissed individually.'};
      });
      result[key]={...p,chats};
      if(gone.length){
        Object.assign(result[key],{work,running:p.running-gone.length,chatCount:chats.length,
          clear:!p.enabled||(p.connected&&work.length===0&&chats.length===0&&p.uncertain===0&&p.scheduled===0&&p.backgroundRunning===0)});
      }
    }
    result.chats=providers.flatMap(k=>result[k]?.chats||[]);
    if(removed.size){
      result.work=snapshot.work.filter(w=>!removed.has(w.key));result.running=snapshot.running-removed.size;result.chatCount=result.chats.length;
      result.clear=result.codex.clear&&result.claude.clear&&(result.codex.enabled||result.claude.enabled);
    }
    return result;
  }
}
module.exports={DismissedWork,inspect,valid};

'use strict';
function item(provider='Codex',session='one',key=provider+':prompt:'+session,extra={}){return{key,provider,session,label:'prompt',status:'Running',reason:'Working',lastEventUtc:'2026-10-11T12:00:00Z',isBackground:false,chatTitle:session,activityToken:'generation:1',...extra};}
function snapshot(items=[item()]){
  const provider=name=>{const work=items.filter(w=>w.provider===name),groups=new Map();for(const w of work.filter(w=>w.status==='Running'&&!w.isBackground)){const a=groups.get(w.session)||[];a.push(w);groups.set(w.session,a);}
    const chats=[...groups].map(([session,a])=>({provider:name,session,title:a[0].chatTitle,promptCount:a.length,startedUtc:a[0].lastEventUtc}));
    return{name,enabled:true,connected:true,work,chats,running:work.filter(w=>w.status==='Running').length,scheduled:work.filter(w=>w.status==='Scheduled').length,uncertain:work.filter(w=>w.status==='Uncertain').length,backgroundRunning:work.filter(w=>w.status==='Running'&&w.isBackground).length,chatCount:chats.length,clear:work.length===0};};
  const codex=provider('Codex'),claude=provider('Claude'),s={codex,claude,work:[...codex.work,...claude.work],chats:[...codex.chats,...claude.chats],revision:1,checkedUtc:'2026-10-11T12:00:00Z',clear:codex.clear&&claude.clear};for(const k of ['running','scheduled','uncertain','backgroundRunning','chatCount'])s[k]=codex[k]+claude[k];return s;
}
module.exports={item,snapshot};

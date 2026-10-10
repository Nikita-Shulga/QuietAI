#!/usr/bin/env node
// Stand-in for QuietAI.Agent: same stdin/stdout JSON-lines protocol, scripted by a control file.
const fs=require('fs'),readline=require('readline');
if(process.argv[2]==='hook'){ // collector mode, like `QuietAI.Agent hook <state>`
  let data='';process.stdin.on('data',d=>data+=d).on('end',()=>{
    const e=JSON.parse(data),dir=require('path').join(process.argv[3],'claude-events');fs.mkdirSync(dir,{recursive:true});
    fs.appendFileSync(require('path').join(dir,e.session_id+'.jsonl'),JSON.stringify({schema:1,event:e.hook_event_name,session_id:e.session_id,timestamp_utc:new Date().toISOString()})+'\n');process.exit(0);});
}else{
const control=()=>{try{return JSON.parse(fs.readFileSync(process.env.QA_CONTROL,'utf8'))}catch{return{}}};
const log=e=>fs.appendFileSync(process.env.QA_LOG,JSON.stringify({t:Date.now(),...e})+'\n');
readline.createInterface({input:process.stdin}).on('line',async line=>{
  const req=JSON.parse(line),c=control();
  log({agent:req.command,codex:req.settings.codexEnabled,claude:req.settings.claudeEnabled,claudeHome:req.settings.claudeHomeOverride,codexSessions:req.settings.codexSessionsOverride});
  const wait=ms=>new Promise(r=>setTimeout(r,ms));
  if(req.command==='scan'){
    await wait(c.scanDelayMs||0);
    const snap=JSON.parse(JSON.stringify(c.snapshot));snap.checkedUtc=new Date(Date.now()+(c.skew||0)).toISOString();
    // Like the real monitor: excluded work keys disappear, and so do chats left with no work.
    const ex=new Set(req.settings.excludedWork||[]);
    if(ex.size)for(const k of ['codex','claude']){const p=snap[k];if(!p)continue;
      const before=p.work.length;p.work=p.work.filter(w=>!ex.has(w.key));
      p.chats=p.chats.filter(ch=>!ch.keys||ch.keys.some(key=>!ex.has(key)));
      if(before!==p.work.length){p.chatCount=p.chats.length;p.running=p.work.filter(w=>w.status==='Running').length;p.clear=p.connected&&!p.work.length;}}
    if(ex.size){snap.work=[...snap.codex.work,...snap.claude.work];snap.chats=[...snap.codex.chats,...snap.claude.chats];snap.chatCount=snap.codex.chatCount+snap.claude.chatCount;snap.running=snap.codex.running+snap.claude.running;snap.clear=snap.codex.clear&&snap.claude.clear;}
    process.stdout.write(JSON.stringify({id:req.id,ok:true,snapshot:snap})+'\n');
  }else if(req.command==='install'||req.command==='remove'){
    await wait(c.installDelayMs||300);
    if(c.installFail)process.stdout.write(JSON.stringify({id:req.id,ok:false,error:c.installFail})+'\n');
    else process.stdout.write(JSON.stringify({id:req.id,ok:true,message:'ok'})+'\n');
  }
});

}

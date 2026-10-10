// Stand-in for uia-watch.ps1: prints what the "windows" show, scripted by the control file.
const fs=require('fs');
setInterval(()=>{let c={};try{c=JSON.parse(fs.readFileSync(process.env.QA_CONTROL,'utf8'))}catch{}
  const w=c.windows||{claude:{windows:1,stops:[]},codex:{windows:1,stops:[]}};
  process.stdout.write(JSON.stringify({...w,ms:5})+'\n');},400);

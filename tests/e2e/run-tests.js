// End-to-end tests for Quiet AI: real Electron + real main.js/renderer, fake monitor, fake power.
const {_electron:electron}=require('playwright');
const fs=require('fs'),path=require('path'),os=require('os');
const ROOT=__dirname,SRC=process.env.QA_SRC||path.join(__dirname,'..','..','desktop');
const ELECTRON=process.env.QUIETAI_ELECTRON||path.join(ROOT,'electron','electron');
const OUT=process.env.QA_OUT||path.join(os.tmpdir(),'quietai-e2e');fs.mkdirSync(OUT,{recursive:true});
const results=[];let failures=0;
function check(name,ok,detail=''){results.push({name,ok:!!ok,detail});if(!ok)failures++;console.log((ok?'PASS ':'FAIL ')+name+(detail?'  — '+detail:''));}
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const MAC=process.platform==='darwin';
const VERSION=JSON.parse(fs.readFileSync(path.join(SRC,'package.json'),'utf8').replace(/^\uFEFF/,'')).version;

// ——— Sandbox: app copy, fake home, profile ———
const run=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'quietai-')));
const app=path.join(run,'app'),home=path.join(run,'home'),profile=path.join(run,'profile');
fs.cpSync(SRC,app,{recursive:true});
fs.copyFileSync(path.join(ROOT,'stubs/power.js'),path.join(app,'power.js'));
fs.mkdirSync(path.join(app,'agent'));fs.copyFileSync(path.join(ROOT,'stubs/fake-agent.js'),path.join(app,'agent/QuietAI.Agent'));fs.chmodSync(path.join(app,'agent/QuietAI.Agent'),0o755);
fs.mkdirSync(path.join(home,'.codex/sessions'),{recursive:true});fs.mkdirSync(path.join(home,'.claude'),{recursive:true});
fs.mkdirSync(profile,{recursive:true});
const stateRoot=path.join(profile,'monitor'),collector=path.join(stateRoot,'integration','agent','QuietAI.Agent');
fs.mkdirSync(path.dirname(collector),{recursive:true});fs.copyFileSync(path.join(ROOT,'stubs/fake-agent.js'),collector);fs.chmodSync(collector,0o755);
const hookCommand=`'${collector}' hook '${stateRoot}'`;
const writeClaudeSettings=cmd=>fs.writeFileSync(path.join(home,'.claude','settings.json'),JSON.stringify({hooks:{SessionStart:[{hooks:[{type:'command',command:cmd,timeout:10}]}],Stop:[{hooks:[{type:'command',command:cmd,timeout:10}]}]}},null,2));
const CONTROL=path.join(run,'control.json'),LOG=path.join(run,'log.jsonl');fs.writeFileSync(LOG,'');
const chat=(p,t,m)=>({provider:p,session:t.replace(/\W/g,''),title:t,promptCount:1,startedUtc:new Date(Date.now()-m*60000).toISOString()});
function provider(name,{enabled=true,connected=true,work=[],chats=[]}={}){return{name,enabled,connected,work,detail:connected?'Connected':'Not connected',chats,chatCount:chats.length,running:chats.length,scheduled:0,uncertain:work.filter(w=>w.status==='Uncertain').length,backgroundRunning:0,clear:!enabled||(connected&&work.length===0&&chats.length===0)};}
let revision=1;
function snapshot(codex,claude){const work=[...codex.work,...claude.work];return{codex,claude,revision:revision++,chats:[...codex.chats,...claude.chats],chatCount:codex.chatCount+claude.chatCount,running:codex.running+claude.running,scheduled:0,uncertain:codex.uncertain+claude.uncertain,backgroundRunning:0,work,clear:codex.clear&&claude.clear&&(codex.enabled||claude.enabled)};}
const busyChats=()=>snapshot(provider('Codex',{chats:[chat('Codex','Build the next release',23),chat('Codex','Polish the settings',7)]}),provider('Claude',{chats:[chat('Claude','Review the docs',64)]}));
const quietSnap=()=>snapshot(provider('Codex'),provider('Claude'));
const claudeNotConnected=reason=>snapshot(provider('Codex'),provider('Claude',{connected:false,work:[{key:'Claude:connection',provider:'Claude',session:'Connection',label:'Connection needs attention',status:'Uncertain',reason}]}));
let control={snapshot:busyChats(),scanDelayMs:0,skew:0};
const setControl=patch=>{control={...control,...patch};fs.writeFileSync(CONTROL,JSON.stringify(control));};
setControl({});
const logLines=()=>fs.readFileSync(LOG,'utf8').trim().split('\n').filter(Boolean).map(l=>JSON.parse(l));
const settingsFile=()=>JSON.parse(fs.readFileSync(path.join(profile,'settings.json'),'utf8'));

(async()=>{
  const eapp=await electron.launch({executablePath:ELECTRON,args:['--no-sandbox',app],env:{...process.env,HOME:home,QUIETAI_PROFILE:profile,QA_CONTROL:CONTROL,QA_LOG:LOG,CODEX_HOME:'',CLAUDE_CONFIG_DIR:'',QUIETAI_TEST_HOOKS:'1',QUIETAI_STALL_LOG_MS:'3000',QUIETAI_STALL_WINDOW_MS:'1500',QUIETAI_WINDOW_WATCHER:path.join(ROOT,'stubs','fake-window-watcher.js')}});
  const page=await eapp.firstWindow();
  // Instrument the main process: controllable clock, power-save blocker, dialogs, notifications.
  await eapp.evaluate(({powerSaveBlocker,dialog,powerMonitor})=>{
    const real=Date.now;global.__skew=0;Date.now=()=>real()+global.__skew;
    // Fake "last mouse/keyboard input": long ago unless a test says the user is at the PC.
    global.__lastInput=-1e15;powerMonitor.getSystemIdleTime=()=>Math.max(0,Math.floor((Date.now()-global.__lastInput)/1000));
    global.__blocks={started:0,stopped:0,active:new Set()};
    const s=powerSaveBlocker.start.bind(powerSaveBlocker),t=powerSaveBlocker.stop.bind(powerSaveBlocker);
    powerSaveBlocker.start=type=>{const id=s(type);global.__blocks.started++;global.__blocks.active.add(id);return id;};
    powerSaveBlocker.stop=id=>{global.__blocks.stopped++;global.__blocks.active.delete(id);return t(id);};
    global.__dialogAnswer=0;global.__dialogs=0;dialog.showMessageBoxSync=()=>{global.__dialogs++;return global.__dialogAnswer;};
    global.__openDialog=null;dialog.showOpenDialog=async()=>global.__openDialog||{canceled:true,filePaths:[]};
  });
  const skew=async ms=>{const total=(control.skew||0)+ms;setControl({skew:total});await eapp.evaluate((_,v)=>{global.__skew=v;},total);};
  const mainState=()=>page.evaluate(()=>window.quiet.command('state'));
  const waitFor=async(fn,ms=8000,step=150)=>{const end=Date.now()+ms;let v;while(Date.now()<end){try{v=await fn();if(v)return v;}catch{}await sleep(step);}return v;};
  const txt=sel=>page.locator(sel).first().innerText();
  const shot=n=>page.screenshot({path:path.join(OUT,n+'.png')});
  const userInput=()=>eapp.evaluate(()=>{global.__lastInput=Date.now();});
  const onTop=()=>eapp.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows().find(w=>w.getTitle()!=='Quiet AI countdown').isAlwaysOnTop());
  
  await page.setViewportSize?.({width:460,height:690}).catch(()=>{});
  await waitFor(async()=>(await txt('#headline')).includes('running'));

  // 1. Startup & discovery
  let s=await mainState();
  check('Window opens at 460×690',await eapp.evaluate(({BrowserWindow})=>{const w=BrowserWindow.getAllWindows().find(w=>w.getTitle()!=='Quiet AI countdown');const [a,b]=w.getSize();return a===460&&b===690;}));
  check('Codex sessions folder found automatically',s.sources.codex.exists&&s.sources.codex.folder===path.join(home,'.codex/sessions'),s.sources.codex.folder);
  check('Claude folder found automatically',s.sources.claude.exists&&s.sources.claude.folder===path.join(home,'.claude'),s.sources.claude.folder);
  check('Both providers enabled by default when found',s.settings.codexEnabled===true&&s.settings.claudeEnabled===true);
  check('Monitor receives the discovered folders',logLines().some(l=>l.agent==='scan'&&l.codexSessions===path.join(home,'.codex/sessions')&&l.claudeHome===path.join(home,'.claude')));
  check('Headline shows running chats',(await txt('#headline'))==='3 chats running',await txt('#headline'));
  check('Running list has 3 rows',(await page.locator('#chat-list li').count())===3);
  check('Elapsed time shown',(await txt('#chat-list li .time')).includes('min'),await txt('#chat-list li .time'));
  check('Version shown matches package.json',s.version===VERSION,s.version);
  await shot('01-main-dark');

  // 2. Drag regions must never cover the window buttons (this was the dead close button)
  const dragProblems=async()=>page.evaluate(()=>{
    const out=[];const targets=['#close','#minimize','#open-settings'].map(s=>document.querySelector(s));
    for(const el of document.querySelectorAll('*')){
      if(getComputedStyle(el).webkitAppRegion!=='drag')continue;
      const r=el.getBoundingClientRect();if(!r.width||!r.height)continue;
      for(const t of targets){if(!t||el.contains(t))continue;const b=t.getBoundingClientRect();
        if(r.left<b.right&&r.right>b.left&&r.top<b.bottom&&r.bottom>b.top)out.push((el.className||el.tagName)+' covers '+t.id);}
    }return out;});
  let dp=await dragProblems();check('No drag region covers window buttons (settings closed)',dp.length===0,dp.join('; '));
  for(const sel of ['#close','#minimize','#open-settings']){const st=await page.$eval(sel,e=>getComputedStyle(e).webkitAppRegion);check(`${sel} is no-drag`,st==='no-drag',st);}

  // 3. Settings open/close via the titlebar toggle
  await page.click('#open-settings');await sleep(400);
  check('Settings opens from titlebar',await page.evaluate(()=>document.body.classList.contains('settings-open')));
  dp=await dragProblems();check('No drag region covers window buttons (settings open)',dp.length===0,dp.join('; '));
  if(MAC)check('macOS uses the native traffic lights (custom window buttons hidden)',await page.evaluate(()=>getComputedStyle(document.querySelector('#close')).display==='none'));
  else check('Titlebar stays visible above Settings',await page.evaluate(()=>{const b=document.querySelector('#close').getBoundingClientRect();return document.elementFromPoint(b.left+b.width/2,b.top+b.height/2)?.closest('#close')!==null;}));
  check('Folder rows show path + "Found automatically"',(await txt('#codex-folder')).endsWith('sessions')&&(await txt('#codex-origin'))==='Found automatically',await txt('#codex-origin'));
  check('"Use automatic" hidden when nothing was chosen manually',await page.locator('.automatic[data-provider="codex"]').evaluate(e=>e.classList.contains('hidden')));
  await shot('02-settings-dark');
  await page.click('#open-settings');await sleep(400);
  check('Titlebar button closes Settings again',!(await page.evaluate(()=>document.body.classList.contains('settings-open'))));

  // 4. Theme switcher: no overflow, persisted
  await page.click('#open-settings');await sleep(300);
  for(const theme of ['light','dark','system']){
    await page.click(`#theme-seg [data-theme="${theme}"]`);await sleep(450);
    const m=await page.evaluate(()=>{const seg=document.querySelector('#theme-seg'),b=seg.querySelector('[aria-pressed="true"]'),t=seg.querySelector('.seg-thumb').getBoundingClientRect(),r=b.getBoundingClientRect(),sr=seg.getBoundingClientRect();
      return{inside:t.left<=r.left+1&&t.right>=r.right-1,textFits:[...seg.querySelectorAll('button')].every(x=>x.scrollWidth<=x.clientWidth+1),inSeg:r.right<=sr.right+0.5&&r.left>=sr.left-0.5,bg:getComputedStyle(document.body).backgroundColor};});
    check(`Theme ${theme}: highlight covers its label, no text overflow`,m.inside&&m.textFits&&m.inSeg,JSON.stringify(m));
    await waitFor(()=>settingsFile().theme===theme,3000);check(`Theme ${theme} saved`,settingsFile().theme===theme,settingsFile().theme);
    if(theme==='light'){check('Light theme applied',m.bg==='rgb(243, 243, 245)',m.bg);await shot('03-settings-light');}
    if(theme==='dark')check('Dark theme applied',m.bg==='rgb(10, 10, 11)',m.bg);
  }

  await page.click('#theme-seg [data-theme="system"]');await sleep(300);
  await page.click('.sheet-body .block-head h2');await page.click('#codex-folder');await sleep(400);
  check('Clicking elsewhere never changes the theme',settingsFile().theme==='system',settingsFile().theme);
  await page.evaluate(()=>window.quiet.command('update',{watchWindows:false})); // hook-only behaviour first
  // 5. Connect Claude Code while the monitor is busy (this was the dead Connect button)
  setControl({snapshot:claudeNotConnected('Connect Claude in Sources, then restart or resume open Claude Code sessions.'),scanDelayMs:1500});
  await waitFor(async()=>(await txt('#claude-hook-status'))==='Not connected',8000);
  check('Claude shows "Not connected" before setup',(await txt('#claude-hook-status'))==='Not connected');
  check('Connect button stays clickable during a scan',await waitFor(async()=>{const st=await mainState();return st.busy&&!(await page.$eval('#install-hooks',e=>e.disabled));},6000));
  setControl({snapshot:claudeNotConnected('Waiting for the first real Claude hook event. Restart or resume Claude Code after setup.')});
  await page.click('#install-hooks');
  check('Button shows progress',await waitFor(async()=>(await txt('#install-hooks'))==='Connecting…',3000));
  check('Install request reaches the monitor',await waitFor(()=>logLines().some(l=>l.agent==='install'),8000));
  const noticeVisible=async()=>page.evaluate(()=>{const n=document.querySelector('#notice');if(n.classList.contains('hidden'))return false;const r=n.getBoundingClientRect();return document.elementFromPoint(r.left+r.width/2,r.top+r.height/2)?.closest('#notice')!==null;});
  check('Success message visible on top of Settings',await waitFor(noticeVisible,8000),await txt('#notice-text').catch(()=>''));
  check('Claude counts as connected after install (no Claude Code session yet)',await waitFor(async()=>(await txt('#claude-hook-status')).startsWith('Connected'),8000),await txt('#claude-hook-status'));
  s=await mainState();
  check('Claude no longer blocks the plan',s.snapshot.claude.connected&&s.snapshot.clear&&s.snapshot.uncertain===0,JSON.stringify({c:s.snapshot.claude.connected,clear:s.snapshot.clear}));
  check('Reconnect/Disconnect offered',(await txt('#install-hooks'))==='Reconnect'&&await page.locator('#remove-hooks').isVisible());
  await shot('04-claude-connected');
  setControl({installFail:'Claude settings disable all hooks.',scanDelayMs:0});
  await page.click('#dismiss-notice').catch(()=>{});
  await page.click('#install-hooks');
  check('Install failure shown to the user',await waitFor(async()=>(await noticeVisible())&&(await txt('#notice-text')).includes('Claude settings disable all hooks'),8000),await txt('#notice-text'));
  await sleep(3500);
  check('Error message stays readable after the next background check',(await noticeVisible())&&(await txt('#notice-text')).includes('disable all hooks'));
  setControl({installFail:null});
  await page.click('#remove-hooks');
  check('Disconnect reaches the monitor',await waitFor(()=>logLines().some(l=>l.agent==='remove'),8000));
  check('Disconnect switches Claude off',await waitFor(async()=>(await mainState()).settings.claudeEnabled===false,5000));
  await page.click('#install-hooks');await waitFor(async()=>(await mainState()).settings.claudeEnabled===true,8000);
  writeClaudeSettings(hookCommand);
  await page.click('#check-claude');
  check('Test connection: working hook is confirmed',await waitFor(async()=>{const c=(await mainState()).claudeCheck;return c&&c.ok&&c.found&&c.ran;},10000),JSON.stringify((await mainState()).claudeCheck));
  check('Test connection shows the result in Settings',await waitFor(async()=>(await txt('#claude-check')).includes('Hook works'),3000));
  check('Test event is cleaned up',fs.readdirSync(path.join(stateRoot,'claude-events')).filter(f=>f.startsWith('quietai-selftest')).length===0);
  writeClaudeSettings("'"+path.join(run,'missing-collector')+"' hook '"+stateRoot+"' # QuietAI.Agent");
  await page.click('#check-claude');
  check('Test connection: broken hook is reported',await waitFor(async()=>{const c=(await mainState()).claudeCheck;return c&&!c.ok&&c.ran&&c.at;},10000)&&(await txt('#claude-check')).includes('Hook problem'),await txt('#claude-check'));
  fs.writeFileSync(path.join(home,'.claude','settings.json'),JSON.stringify({hooks:{}}));
  await page.click('#check-claude');
  check('Test connection: missing hook is reported',await waitFor(async()=>{const c=(await mainState()).claudeCheck;return c&&!c.found&&c.problem.includes('not in');},10000));
  writeClaudeSettings(hookCommand);

  // 6. Folder choice and discovery
  const custom=path.join(run,'elsewhere/sessions');fs.mkdirSync(custom,{recursive:true});
  await eapp.evaluate((_,f)=>{global.__openDialog={canceled:false,filePaths:[f]};},custom);
  await page.click('.browse[data-provider="codex"]');
  check('Choose… sets a custom folder',await waitFor(async()=>(await txt('#codex-origin'))==='Chosen by you',5000),await txt('#codex-origin'));
  check('Custom folder passed to the monitor',await waitFor(()=>logLines().some(l=>l.agent==='scan'&&l.codexSessions===custom),5000));
  await page.click('.automatic[data-provider="codex"]');
  check('Use automatic restores discovery',await waitFor(async()=>(await txt('#codex-origin'))==='Found automatically',5000));
  await page.click('#discover');
  check('Find folders again works',await waitFor(async()=>(await txt('#notice-text')).startsWith('Discovery refreshed'),5000),await txt('#notice-text'));
  await page.click('#codex-toggle');await sleep(400);
  check('Codex toggle off saved',settingsFile().codexEnabled===false);
  await page.click('#codex-toggle');await sleep(400);
  check('Codex toggle on saved',settingsFile().codexEnabled===true);
  await eapp.evaluate(({clipboard})=>clipboard.writeText(''));
  await page.click('#diagnostics');await sleep(300);
  const clip=await eapp.evaluate(({clipboard})=>clipboard.readText());
  check('Copy status summary works',clip.includes('"version": "'+VERSION+'"')&&!clip.includes(home),clip.slice(0,80));
  await eapp.evaluate(({shell})=>{globalThis.__opened=[];shell.openExternal=url=>{globalThis.__opened.push(url);return Promise.resolve();};});
  check('About credits the author',(await txt('#website'))==='Nikita Shulga');
  await page.click('#website');await sleep(300);
  const opened=await eapp.evaluate(()=>globalThis.__opened);
  check('Author link opens the website in the browser',opened.length===1&&opened[0]==='https://nikitashulga.com',JSON.stringify(opened));
  await page.click('#close-settings');await sleep(300);

  await page.click('#open-settings');await page.click('#diagnostics');await page.click('#close-settings');
  check('Messages disappear on their own',await waitFor(async()=>page.$eval('#notice',e=>e.classList.contains('hidden')),7000));
  await page.evaluate(()=>window.quiet.command('update',{watchWindows:false}));
  setControl({snapshot:claudeNotConnected('Connect Claude in Sources, then restart or resume open Claude Code sessions.')});
  check('Banner appears when Claude is not connected',await waitFor(()=>page.locator('#banner').isVisible(),6000));
  await page.click('#banner');await sleep(300);
  check('Banner "Set up" opens Settings',await page.evaluate(()=>document.body.classList.contains('settings-open')));
  await page.click('#close-settings');await sleep(300);
  await page.evaluate(()=>window.quiet.command('update',{watchWindows:true}));
  await page.click('#codex-chip');await sleep(300);
  check('App chip does not open Settings',!(await page.evaluate(()=>document.body.classList.contains('settings-open'))));
  check('App chip explains itself on hover',(await page.$eval('#codex-chip',e=>e.title)).startsWith('Codex ·'),await page.$eval('#codex-chip',e=>e.title));
  // 6b. App window watching (Chat/Cowork/cloud work shown in the desktop apps)
  await page.evaluate(()=>window.quiet.command('update',{watchWindows:true}));
  setControl({snapshot:claudeNotConnected('Connect Claude in Sources, then restart or resume open Claude Code sessions.'),windows:{claude:{windows:1,stops:[]},codex:{windows:1,stops:[]}}});
  check('Claude counts as watched via its window even without the hook',await waitFor(async()=>{const st=await mainState();return st.snapshot.claude.connected&&st.snapshot.claude.viaWindowOnly&&st.snapshot.clear;},8000));
  check('No "not connected" banner when the window is watched',await waitFor(async()=>!(await page.locator('#banner').isVisible()),4000));
  setControl({windows:{claude:{windows:1,stops:['Stop response']},codex:{windows:1,stops:[]}}});
  check('A Stop button in the Claude app counts as a running chat',await waitFor(async()=>(await txt('#headline'))==='1 chat running',8000),await txt('#headline'));
  check('Running list names the Claude app',await waitFor(async()=>/Claude app · (Chat\/Cowork )?working/.test(await txt('#chat-list')),4000));
  s=await mainState();check('Plan is blocked while the app works',!s.snapshot.clear);
  setControl({windows:{claude:{windows:1,stops:['Stop response']},codex:{windows:1,stops:['Interrupt']}}});
  check('Codex app work counts too',await waitFor(async()=>(await txt('#headline'))==='2 chats running',8000),await txt('#headline'));
  setControl({windows:{claude:{windows:1,stops:['Stop response'],running:['Fight AI program review','Weekly report'],working:2},codex:{windows:1,stops:['Stop'],running:[],working:2}}});
  check('Claude sidebar "Running …" chats are listed by name',await waitFor(async()=>{const t=await txt('#chat-list');return t.includes('Fight AI program review')&&t.includes('Weekly report');},8000),await txt('#chat-list'));
  check('Codex busy markers become a task count',await waitFor(async()=>(await txt('#chat-list')).includes('Codex app · 2 tasks working'),4000),await txt('#chat-list'));
  check('Headline counts named chats and Codex tasks',(await txt('#headline'))==='3 chats running',await txt('#headline'));
  setControl({windows:{claude:{windows:1,stops:[],running:[],working:0},codex:{windows:1,stops:[],running:['"C:\\\\Users\\\\me\\\\.cache\\\\codex-runtimes\\\\node.exe" build.js'],working:0}}});
  check('A command Codex is running is never shown as a chat',await waitFor(async()=>{const t=await txt('#chat-list');return t.includes('Codex app · working')&&!t.includes('codex-runtimes');},8000),await txt('#chat-list'));
  check('…but it still counts as Codex working',!(await mainState()).snapshot.clear);
  setControl({windows:{claude:{windows:1,stops:['Stop response'],running:[],working:0},codex:{windows:1,stops:['Interrupt'],running:[],working:0}}});await sleep(1500);
  await page.click('#open-settings');await sleep(300);
  check('Settings shows what the watcher sees',await waitFor(async()=>(await txt('#win-claude')).includes('Stop response'),4000),await txt('#win-claude'));
  await page.click('#windows-toggle');
  check('Turning window watching off removes it',await waitFor(async()=>{const st=await mainState();return st.settings.watchWindows===false&&st.snapshot.chatCount===0;},8000));
  await page.click('#windows-toggle');await waitFor(async()=>(await mainState()).settings.watchWindows===true,4000);
  await page.click('#close-settings');await sleep(200);
  setControl({windows:{claude:{windows:1,stops:[]},codex:{windows:1,stops:[]}},snapshot:quietSnap()});
  check('When the Stop buttons disappear everything is clear',await waitFor(async()=>{const st=await mainState();return st.snapshot.clear&&st.snapshot.chatCount===0;},8000));

  // 6c. Codex turns that ended without a completion record (interrupted, crashed, app restarted)
  {
    const logDir=path.join(home,'.codex/sessions/2026/10/08');fs.mkdirSync(logDir,{recursive:true});
    const mk=(name,originator,ageMin)=>{const f=path.join(logDir,name);fs.writeFileSync(f,JSON.stringify({type:'session_meta',payload:{id:name,originator}})+'\n');const t=new Date(Date.now()-ageMin*60000);fs.utimesSync(f,t,t);return f;};
    const desk=mk('rollout-desk.jsonl','Codex Desktop',30),cli=mk('rollout-cli.jsonl','codex_cli_rs',30),fresh=mk('rollout-fresh.jsonl','Codex Desktop',0);
    const T=n=>`01a11a17-02da-7483-a20b-6b90740fe4f${n}`;
    const turn=(f,n,minAgo)=>({key:`Codex:${f}:${T(n)}`,provider:'Codex',session:path.basename(f),label:'Turn '+n,status:'Running',reason:'',lastEventUtc:new Date(Date.now()-minAgo*60000).toISOString()});
    const A=turn(desk,1,360),B=turn(desk,2,1),C=turn(cli,3,180),D=turn(fresh,4,1);
    const codexChat=(title,keys,min)=>({...chat('Codex',title,min),keys});
    const snapStale=()=>snapshot(provider('Codex',{work:[A,B,C,D],chats:[codexChat('Pixel game',[A.key,B.key],360),codexChat('Terminal job',[C.key],180),codexChat('Fresh desktop turn',[D.key],1)]}),provider('Claude'));
    const keys=async()=>((await mainState()).snapshot.codex.work||[]).map(w=>w.key);
    setControl({snapshot:snapStale(),windows:{claude:{windows:1,stops:[]},codex:{windows:1,stops:['Stop'],running:[],working:1}}});
    check('An older turn in the same Codex chat is retired once a newer turn starts',await waitFor(async()=>{const k=await keys();return !k.includes(A.key)&&k.includes(B.key);},8000),JSON.stringify(await keys()));
    await sleep(2500);
    check('A turn is kept while the Codex app shows it working',(await keys()).includes(B.key));
    const writing=setInterval(()=>{const t=new Date();fs.utimesSync(fresh,t,t);},300); // this chat's log keeps being written
    setControl({windows:{claude:{windows:1,stops:[]},codex:{windows:1,stops:[],running:[],working:0}}});
    check('A Codex app turn with no log activity is retired once the app shows nothing working',await waitFor(async()=>!(await keys()).includes(B.key),10000),JSON.stringify(await keys()));
    let k=await keys();
    check('A terminal (CLI) Codex turn is never retired by the app window',k.includes(C.key));
    check('A Codex app turn whose log is still being written is kept',k.includes(D.key));
    clearInterval(writing);
    const titles=((await mainState()).snapshot.chats||[]).map(c=>c.title);
    check('The retired chat leaves the Running list',!titles.includes('Pixel game')&&titles.includes('Terminal job'),titles.join(', '));
    // A turn the monitor still holds is over once the chat's log shows a later turn (window busy or not).
    const old=mk('rollout-old.jsonl','Codex Desktop',30);
    const E=(type,turn)=>JSON.stringify({timestamp:new Date().toISOString(),type:'event_msg',payload:{type,turn_id:turn}})+'\n';
    fs.appendFileSync(old,E('task_started',T(5))+E('task_started',T(6))+E('task_complete',T(6)));
    const O=turn(old,5,600);
    setControl({snapshot:snapshot(provider('Codex',{work:[O],chats:[codexChat('Yesterday',[O.key],600)]}),provider('Claude')),windows:{claude:{windows:1,stops:[]},codex:{windows:1,stops:['Stop'],running:[],working:1}}});
    const retiredOld=()=>{try{return fs.readFileSync(path.join(stateRoot,'quietai-activity.log'),'utf8').split('\n').some(l=>l.includes('codex-turn-retired')&&l.includes(T(5))&&l.includes('superseded'));}catch{return false;}};
    check('A turn whose chat later started and finished another turn is retired (even while the app looks busy)',await waitFor(async()=>retiredOld()&&!(await keys()).includes(O.key),8000),JSON.stringify(await keys()));
    setControl({snapshot:quietSnap(),windows:{claude:{windows:1,stops:[]},codex:{windows:1,stops:[]}}});
  }
  setControl({snapshot:busyChats()});
  // 7. Plan menus
  setControl({snapshot:busyChats()});await sleep(400);
  const pick=async(menu,label)=>{await page.click(`.select[data-menu="${menu}"]`);await page.locator('#menu button',{hasText:label}).first().click();await sleep(350);};
  await pick('action','Hibernate');check('Action menu → Hibernate',settingsFile().action==='Hibernate');
  await pick('quietMinutes','1 minute');check('Quiet period → 1 minute',settingsFile().quietMinutes===1);
  await pick('countdownSeconds','30 seconds');check('Time to cancel → 30 seconds',settingsFile().countdownSeconds===30);
  await page.click('.select[data-menu="action"]');await page.keyboard.press('Escape');await sleep(200);
  check('Esc closes an open menu',await page.$eval('#menu',e=>e.hidden));
  check('Summary reflects the plan',(await txt('#summary')).includes('hibernate after 1 minute'),await txt('#summary'));

  // 8. Agent plan: waiting → idle → countdown → action
  await page.click('#headline');await page.keyboard.press('Enter');
  check('Enter arms the plan',await waitFor(async()=>(await mainState()).plan.phase==='waiting',4000),await mainState().then(x=>JSON.stringify({ph:x.plan.phase,clear:x.snapshot.clear,cc:x.snapshot.chatCount,work:x.snapshot.work.map(w=>w.key),cl:x.snapshot.claude.clear,co:x.snapshot.codex.clear,ww:x.settings.watchWindows})));
  check('Badge says Armed',(await txt('.badge'))==='Armed');
  check('Plan rows lock while armed',await page.$eval('#plan',e=>e.classList.contains('locked')));
  check('PC kept awake while armed',await eapp.evaluate(()=>global.__blocks.active.size===1));
  await shot('05-armed');
  setControl({snapshot:quietSnap()});
  check('All quiet → confirming',await waitFor(async()=>(await mainState()).plan.phase==='idle',6000));
  setControl({snapshot:busyChats()});
  check('New activity resets to waiting',await waitFor(async()=>(await mainState()).plan.phase==='waiting',6000));
  setControl({snapshot:quietSnap()});await waitFor(async()=>(await mainState()).plan.phase==='idle',6000);
  setControl({windows:{claude:{windows:1,stops:['Stop response']},codex:{windows:1,stops:[]}}});
  check('Claude app starting to work resets the confirmation',await waitFor(async()=>(await mainState()).plan.phase==='waiting',6000));
  setControl({windows:{claude:{windows:1,stops:[]},codex:{windows:1,stops:[]}}});await waitFor(async()=>(await mainState()).plan.phase==='idle',6000);
  await skew(61000);
  check('After quiet period → final countdown',await waitFor(async()=>(await mainState()).plan.phase==='countdown',4000));
  check('Countdown headline',(await txt('#headline')).startsWith('Hibernating in'),await txt('#headline'));
  check('Window brought forward at countdown',await eapp.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows().find(w=>w.getTitle()!=='Quiet AI countdown').isVisible()));
  check('Countdown floats above other windows',await onTop());
  const banners=()=>eapp.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows().filter(w=>w.getTitle()==='Quiet AI countdown'&&w.isVisible()).map(w=>({top:w.isAlwaysOnTop(),focusable:w.isFocusable()})));
  check('A countdown banner appears on top of everything, without taking focus',await waitFor(async()=>{const b=await banners();return b.length>=1&&b.every(x=>x.top&&!x.focusable);},4000),JSON.stringify(await banners()));
  await sleep(600);{const b64=await eapp.evaluate(async({BrowserWindow})=>{const w=BrowserWindow.getAllWindows().find(x=>x.getTitle()==='Quiet AI countdown');return (await w.webContents.capturePage()).toPNG().toString('base64');});fs.writeFileSync(path.join(OUT,'06b-banner.png'),Buffer.from(b64,'base64'));}
  check('The banner shows the countdown',await waitFor(()=>eapp.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows().find(w=>w.getTitle()==='Quiet AI countdown').webContents.executeJavaScript("document.getElementById('title').textContent")).then(t=>/^Hibernating in \d+:\d\d$/.test(t)),4000));
  await shot('06-countdown');
  await page.keyboard.press('Escape');
  check('Esc cancels the countdown',await waitFor(async()=>(await mainState()).plan.phase==='disarmed',3000));
  check('Window stops floating after cancel',await waitFor(async()=>!(await onTop()),3000));
  check('…and the banner goes away',await waitFor(async()=>(await banners()).length===0,3000));
  check('Blocker released after cancel',await eapp.evaluate(()=>global.__blocks.active.size===0));
  check('No power action after cancel',!logLines().some(l=>l.power));
  await page.click('#arm');await waitFor(async()=>(await mainState()).plan.phase==='idle',6000);
  await skew(61000);await waitFor(async()=>(await mainState()).plan.phase==='countdown',4000);
  await skew(31000);
  check('Countdown end → action requested once',await waitFor(()=>logLines().filter(l=>l.power==='Hibernate').length===1,6000));
  check('Phase completed',(await mainState()).plan.phase==='completed');
  check('Blocker released after action',await eapp.evaluate(()=>global.__blocks.active.size===0));

  // 8b. Someone is using the computer
  await page.click('#arm');await waitFor(async()=>(await mainState()).plan.phase==='idle',6000);
  await eapp.evaluate(()=>{global.__lastInput=Date.now()+61000;});await skew(61000);await sleep(800); // the user is at the PC as the quiet period ends
  let st=await mainState();
  check('AI finished but the user is active → no countdown',st.plan.phase==='idle'&&st.plan.present===true,st.plan.phase);
  check('Headline says it waits for you to step away',(await txt('#headline')).startsWith('Waiting for you'),await txt('#headline'));
  await shot('07-waiting-for-you');
  await skew(10*60000+1000);
  check('After 10 minutes with no input (the default “away” time) → final countdown',await waitFor(async()=>(await mainState()).plan.phase==='countdown',4000));
  await userInput();
  check('Moving the mouse during the countdown cancels it',await waitFor(async()=>{const x=await mainState();return x.plan.phase==='idle'&&x.plan.present;},3000));
  check('…and the window stops floating',await waitFor(async()=>!(await onTop()),3000));
  check('…and no power action happened',logLines().filter(l=>l.power).length===1);
  await page.click('#arm');await waitFor(async()=>(await mainState()).plan.phase==='disarmed',3000);
  await page.click('#open-settings');await sleep(300);
  check('Settings explains the away rule',(await txt('#away-detail')).includes('no mouse or keyboard use'));
  await page.click('#away-toggle');await sleep(400);
  check('“Wait until I’m away” can be turned off',settingsFile().waitForAway===false);
  await page.click('#close-settings');await sleep(300);
  await page.click('#arm');await waitFor(async()=>(await mainState()).plan.phase==='idle',6000);
  await eapp.evaluate(()=>{global.__lastInput=Date.now()+61000;});await skew(61000);
  check('With it off, activity does not hold the countdown',await waitFor(async()=>(await mainState()).plan.phase==='countdown',4000));
  await page.keyboard.press('Escape');await waitFor(async()=>(await mainState()).plan.phase==='disarmed',3000);
  await page.click('#open-settings');await sleep(300);await page.click('#away-toggle');await sleep(400);await page.click('#close-settings');await sleep(300);
  check('…and back on',settingsFile().waitForAway===true);

  // 8c. Cancel from the banner
  await eapp.evaluate(()=>{global.__lastInput=-1e15;}); // nobody at the PC
  await page.click('#arm');await waitFor(async()=>(await mainState()).plan.phase==='idle',6000);
  await skew(61000);await waitFor(async()=>(await mainState()).plan.phase==='countdown',4000);
  await waitFor(async()=>(await banners()).length>=1,4000);await sleep(500);
  await eapp.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows().find(w=>w.getTitle()==='Quiet AI countdown').webContents.executeJavaScript("document.getElementById('cancel').click()"));
  check('Cancel on the banner cancels the countdown',await waitFor(async()=>(await mainState()).plan.phase==='disarmed',3000));
  check('…and closes the banner',await waitFor(async()=>(await banners()).length===0,3000));
  check('…and nothing was switched off',logLines().filter(l=>l.power).length===1);
  await page.click('#open-settings');await sleep(300);
  await page.click('.select[data-menu="awayMinutes"]');await page.locator('#menu button',{hasText:'5 minutes'}).first().click();await sleep(400);
  check('“Away means” can be set (5 minutes)',settingsFile().awayMinutes===5);
  await page.click('.select[data-menu="awayMinutes"]');await page.locator('#menu button',{hasText:'10 minutes'}).first().click();await sleep(400);
  await page.click('#close-settings');await sleep(300);

  // 9. Countdown refuses to act on stale or busy state
  await page.click('#arm');await waitFor(async()=>(await mainState()).plan.phase==='idle',6000);
  await skew(61000);await waitFor(async()=>(await mainState()).plan.phase==='countdown',4000);
  setControl({snapshot:busyChats()});await skew(31000);
  check('Work at the last second cancels the action',await waitFor(async()=>(await mainState()).plan.phase==='waiting',6000));
  check('Still exactly one power action',logLines().filter(l=>l.power).length===1);
  await page.click('#arm');await sleep(300);
  check('Stop button disarms',(await mainState()).plan.phase==='disarmed');

  // 10. Timer mode
  await pick('scheduleMode','On a timer');await pick('timerMinutes','5 minutes');await pick('action','Lock screen');
  check('Timer settings saved',settingsFile().scheduleMode==='Timer'&&settingsFile().timerMinutes===5);
  await page.click('#arm');
  check('Timer runs regardless of AI',await waitFor(async()=>(await mainState()).plan.phase==='timer',3000));
  await skew(5*60000+1000);
  check('Timer → countdown',await waitFor(async()=>(await mainState()).plan.phase==='countdown',4000));
  await skew(31000);
  check('Timer action requested',await waitFor(()=>logLines().some(l=>l.power==='Lock'),6000));
  await pick('scheduleMode','After AI finishes');

  // Manual review: real main/renderer/IPC; native menu/dialog selections recorded.
  // Power remains the record-only module for the entire harness.
  {
    const {snapshot:roots,item:root}=require('../desktop/dismissal-fixtures.cjs');
    await page.evaluate(()=>window.quiet.command('stop'));
    await page.evaluate(()=>window.quiet.command('update',{watchWindows:false,waitForAway:false,scheduleMode:'Codex',codexEnabled:true,claudeEnabled:true}));
    const powerBefore=logLines().filter(l=>l.power).length;
    await eapp.evaluate(({Menu,dialog})=>{
      const build=Menu.buildFromTemplate.bind(Menu);
      Menu.buildFromTemplate=template=>{const menu=build(template);if(template[0]?.label==='Dismiss current prompts…')menu.popup=()=>{global.__chatMenu=menu;};return menu;};
      global.__manualChoice=0;global.__manualAck=false;global.__manualDialogs=[];
      dialog.showMessageBox=async(_window,options)=>{global.__manualDialogs.push(options);return{response:global.__manualChoice,checkboxChecked:global.__manualAck};};
    });
    const openRowMenu=async()=>{await page.locator('#chat-list li').first().click({button:'right'});return waitFor(()=>eapp.evaluate(()=>!!global.__chatMenu),3000);};
    const selectDismiss=()=>eapp.evaluate(()=>global.__chatMenu.items[0].click());
    setControl({snapshot:roots()});
    check('Manual review: verified root row offers an accessible action',await waitFor(async()=>(await mainState()).snapshot.chats[0]?.dismissible,5000)&&await page.locator('.chat-actions').first().getAttribute('aria-haspopup')==='menu');
    await openRowMenu();check('Manual review: native contextual menu enables current prompt dismissal',await eapp.evaluate(()=>global.__chatMenu.items[0].enabled));
    await selectDismiss();
    check('Manual review: warning defaults to Cancel',await waitFor(()=>eapp.evaluate(()=>global.__manualDialogs.length>0),3000)&&await eapp.evaluate(()=>global.__manualDialogs.at(-1).defaultId===0&&global.__manualDialogs.at(-1).cancelId===0));
    check('Manual review: Cancel retains the blocker',(await mainState()).dismissed.count===0&&(await mainState()).snapshot.clear===false);
    await eapp.evaluate(()=>{global.__manualChoice=1;global.__manualAck=false;global.__chatMenu=null;});await openRowMenu();await selectDismiss();
    check('Manual review: a native Dismiss/Return response without acknowledgment keeps blockers',await waitFor(async()=>(await mainState()).message.includes('Nothing was dismissed'),3000)&&(await mainState()).dismissed.count===0&&(await mainState()).snapshot.clear===false);
    await eapp.evaluate(()=>{global.__manualChoice=1;global.__manualAck=true;global.__chatMenu=null;});await openRowMenu();await selectDismiss();
    check('Manual review: confirmed current root hidden with visible Restore',await waitFor(async()=>(await mainState()).dismissed.count===1,5000)&&await page.locator('#dismissed-work').isVisible()&&(await mainState()).snapshot.clear===true);
    await sleep(2500);check('Manual review: unchanged periodic scan preserves dismissal',(await mainState()).dismissed.count===1&&(await mainState()).snapshot.chatCount===0);
    await page.locator('#restore-dismissed').click();
    check('Manual review: Restore returns current running blocker',await waitFor(async()=>(await mainState()).dismissed.count===0&&(await mainState()).snapshot.chatCount===1,3000));
    // Context-menu keyboard key uses the same IPC and native menu.
    await eapp.evaluate(()=>{global.__chatMenu=null;});await page.locator('.chat-actions').first().focus();await page.keyboard.press('Shift+F10');
    check('Manual review: keyboard opens the same native menu',await waitFor(()=>eapp.evaluate(()=>!!global.__chatMenu),3000));
    await selectDismiss();await waitFor(async()=>(await mainState()).dismissed.count===1,3000);
    setControl({snapshot:roots([root('Codex','one',undefined,{activityToken:'generation:2'})])});
    check('Manual review: new same-key observed activity restores the blocker',await waitFor(async()=>(await mainState()).dismissed.count===0&&(await mainState()).snapshot.chatCount===1,5000));
    check('Manual review: never requests extra power',logLines().filter(l=>l.power).length===powerBefore);
    await shot('manual-dismissal-restored');
    setControl({snapshot:busyChats()});await waitFor(async()=>(await mainState()).snapshot.chatCount===3,5000);
    // Preserve the existing suite's settings/persistence expectations.
    await page.evaluate(()=>window.quiet.command('update',{watchWindows:true}));
  }

  // 10b. Activity log (explains afterwards what a plan waited for)
  {const f=path.join(stateRoot,'quietai-activity.log');let lines=[];try{lines=fs.readFileSync(f,'utf8').trim().split('\n').map(l=>JSON.parse(l));}catch{}
   check('Activity log records plan phases',lines.some(l=>l.event==='phase'&&l.to==='countdown')&&lines.some(l=>l.event==='start'),f);
   check('Activity log records retired Codex turns',lines.some(l=>l.event==='codex-turn-retired'));}
  // 11a. Minimize to the tray (Windows/Linux) or the menu bar (macOS)
  const mainWin="BrowserWindow.getAllWindows().find(w=>w.getTitle()!=='Quiet AI countdown')";
  const vis=()=>eapp.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows().find(w=>w.getTitle()!=='Quiet AI countdown').isVisible());
  // macOS has native traffic lights instead of the custom buttons, so drive the window itself there.
  const minimizeWin=()=>MAC?eapp.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows().find(w=>w.getTitle()!=='Quiet AI countdown').minimize()):page.click('#minimize');
  const closeWin=(pg=page,ea=eapp)=>MAC?ea.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows().find(w=>w.getTitle()!=='Quiet AI countdown').close()):pg.click('#close');
  const menuItem=label=>eapp.evaluate((_,l)=>{const it=global.__quietTray.menu().items.find(i=>i.label===l);if(!it||!it.enabled)return false;it.click();return true;},label);
  // On macOS a tray click pops the menu up natively (a modal loop), so record it instead.
  if(MAC)await eapp.evaluate(()=>{global.__popups=0;global.__quietTray.tray.popUpContextMenu=()=>{global.__popups++;};});
  const trayClickRestores=async()=>{
    await eapp.evaluate(()=>global.__quietTray.tray.emit('click'));
    if(MAC){if(!await waitFor(()=>eapp.evaluate(()=>global.__popups>0),3000))return false;await menuItem('Open Quiet AI');}
    return waitFor(vis,3000);
  };
  check('Tray icon is created',await eapp.evaluate(()=>!!global.__quietTray));
  check('Tray tooltip shows the status',await waitFor(()=>eapp.evaluate(()=>/^Quiet AI — (Not armed|\d+ chats? running)/.test(global.__quietTray.tip())),3000),await eapp.evaluate(()=>global.__quietTray.tip()));
  await minimizeWin();
  check('Minimize hides the window to the tray',await waitFor(async()=>!(await vis()),3000));
  // The hint counts as shown only once macOS really showed it; if notifications aren't allowed
  // (e.g. a bare Electron binary) the failure is logged and the hint is tried again next time.
  {const hintFailed=()=>{try{return fs.readFileSync(path.join(stateRoot,'quietai-activity.log'),'utf8').includes('"kind":"tray-hint"');}catch{return false;}};
   check('The tray hint is shown only once (or its failure is logged)',await waitFor(()=>settingsFile().trayHintShown===true||(MAC&&hintFailed()),3000));}
  check(MAC?'Clicking the menu-bar icon shows its menu, and Open Quiet AI brings the window back':'Clicking the tray icon brings the window back',await trayClickRestores());
  let labels=await eapp.evaluate(()=>global.__quietTray.menu().items.map(i=>i.label+':'+i.enabled));
  if(MAC){check('Menu-bar menu starts with the plan status (not clickable)',/^(Not armed|\d+ chats? running):false$/.test(labels[0])&&labels[1]===':true',labels.slice(0,2).join('|'));labels=labels.slice(2);}
  check('Tray menu: Open, Stop plan (disabled when not armed), Quit',labels.join('|')==='Open Quiet AI:true|Stop plan:false|:true|Quit Quiet AI:true',labels.join('|'));
  await page.click('#arm');await waitFor(async()=>['waiting','idle'].includes((await mainState()).plan.phase),4000);
  await minimizeWin();await waitFor(async()=>!(await vis()),3000);
  check('Tray tooltip follows the plan',await eapp.evaluate(()=>/armed|confirming|Armed/i.test(global.__quietTray.tip())),await eapp.evaluate(()=>global.__quietTray.tip()));
  if(MAC)check('Menu-bar menu shows the plan status',await eapp.evaluate(()=>/armed|confirming|Armed/i.test(global.__quietTray.menu().items[0].label)),await eapp.evaluate(()=>global.__quietTray.menu().items[0].label));
  check('Stop plan works from the tray menu',await menuItem('Stop plan')&&await waitFor(async()=>(await mainState()).plan.phase==='disarmed',3000));
  await trayClickRestores();
  if(MAC){
    await closeWin();
    check('macOS: closing the window keeps Quiet AI in the menu bar',await waitFor(async()=>!(await vis()),3000)&&await eapp.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows().length>=1));
    await eapp.evaluate(({app})=>app.emit('activate'));
    check('macOS: clicking the Dock icon brings the window back',await waitFor(vis,3000));
  }
  // Quit from anywhere (Cmd-Q, Dock, menu) while armed asks first; Keep running keeps the plan.
  setControl({snapshot:busyChats()});await page.click('#arm');await waitFor(async()=>(await mainState()).plan.phase==='waiting',3000);
  await eapp.evaluate(()=>{global.__dialogAnswer=0;global.__dialogs=0;});
  await eapp.evaluate(({app})=>{app.quit();});await sleep(600);
  check('Quit while armed asks first; Keep running keeps the plan',await eapp.evaluate(()=>global.__dialogs===1)&&(await mainState()).plan.phase==='waiting');
  await page.click('#arm');await waitFor(async()=>(await mainState()).plan.phase==='disarmed',3000);
  await page.click('#open-settings');await sleep(300);await page.click('#tray-toggle');await sleep(400);await page.click('#close-settings');await sleep(300);
  check('“Minimize to tray” can be turned off',settingsFile().minimizeToTray===false);

  // 11. Minimize, close confirmation, close
  await eapp.evaluate(({BrowserWindow})=>{const w=BrowserWindow.getAllWindows().find(w=>w.getTitle()!=='Quiet AI countdown');global.__min=0;w.on('minimize',()=>global.__min++);});
  await minimizeWin();
  check('Minimize minimizes the window (tray off)',await waitFor(()=>eapp.evaluate(({BrowserWindow})=>global.__min===1&&BrowserWindow.getAllWindows().find(w=>w.getTitle()!=='Quiet AI countdown').isMinimized()),3000));
  await eapp.evaluate(({BrowserWindow})=>{const w=BrowserWindow.getAllWindows().find(w=>w.getTitle()!=='Quiet AI countdown');w.restore();w.show();});await sleep(400);
  setControl({snapshot:busyChats()});await page.click('#arm');await waitFor(async()=>(await mainState()).plan.phase==='waiting',3000);
  await eapp.evaluate(()=>{global.__dialogAnswer=0;global.__dialogs=0;});
  await closeWin();await sleep(600);
  check('Close while armed asks first and can keep running',await eapp.evaluate(({BrowserWindow})=>global.__dialogs===1&&BrowserWindow.getAllWindows().length===1));
  await eapp.evaluate(()=>{global.__dialogAnswer=1;});
  const closed=eapp.waitForEvent('close',{timeout:8000}).then(()=>true).catch(()=>false);
  await closeWin().catch(()=>{});
  check('Close button quits the app',await closed);

  // 12. Second launch keeps settings and theme
  const eapp2=await electron.launch({executablePath:ELECTRON,args:['--no-sandbox',app],env:{...process.env,HOME:home,QUIETAI_PROFILE:profile,QA_CONTROL:CONTROL,QA_LOG:LOG,CODEX_HOME:'',CLAUDE_CONFIG_DIR:'',QUIETAI_STALL_LOG_MS:'3000',QUIETAI_STALL_WINDOW_MS:'1500',QUIETAI_WINDOW_WATCHER:path.join(ROOT,'stubs','fake-window-watcher.js')}});
  const p2=await eapp2.firstWindow();await sleep(1500);
  const s2=await p2.evaluate(()=>window.quiet.command('state'));
  check('Settings persist across restarts',s2.settings.scheduleMode==='Codex'&&s2.settings.action==='Lock'&&s2.settings.theme==='system'&&s2.plan.phase==='disarmed');
  const closed2=eapp2.waitForEvent('close',{timeout:8000}).then(()=>true).catch(()=>false);
  await closeWin(p2,eapp2).catch(()=>{});
  check('Close works with nothing armed (no prompt)',await closed2);

  fs.writeFileSync(path.join(OUT,'results.json'),JSON.stringify({failures,results},null,1));
  console.log(`\n${results.length-failures}/${results.length} passed`);
  try{await eapp2.close();}catch{}
  process.exit(failures?1:0);
})().catch(e=>{console.error('HARNESS ERROR',e);process.exit(2);});

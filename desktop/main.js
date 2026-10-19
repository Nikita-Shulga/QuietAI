'use strict';
const {app,BrowserWindow,ipcMain,dialog,Menu,clipboard,powerSaveBlocker,Notification,nativeImage,nativeTheme,shell,powerMonitor,Tray}=require('electron');
const WEBSITE='https://nikitashulga.com';
const {execFile}=require('node:child_process');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const Agent=require('./agent');
const {discover}=require('./discovery');
const power=require('./power');
const updater=require('./updater');
const i18n=require('./i18n'),{tr}=i18n; // interface language: settings.language, English by default
const {DismissedWork,inspect}=require('./dismissed-work');
const dismissedWork=new DismissedWork();
let rawSnapshot=null,scanSerial=0,manualReview=false;
const preview=process.argv.includes('--preview');
const configRoot=process.env.QUIETAI_PROFILE || (process.platform==='win32'?path.join(process.env.LOCALAPPDATA,'QuietAI'):path.join(os.homedir(),'Library','Application Support','Quiet AI'));
app.setPath('userData',path.join(configRoot,'desktop'));
app.setName('Quiet AI');
if(process.platform==='win32')app.setAppUserModelId('org.quietai.desktop');
const primaryInstance=app.requestSingleInstanceLock();
if(!primaryInstance)app.quit();
const VERSION=require('./package.json').version;
let window,settings,sources,snapshot=null,busy=false,agent,error='',message='',lastRevision=null,operation=null,claudeCheck=null;
let plan={phase:'disarmed',until:null,started:null};
const settingsPath=path.join(configRoot,'settings.json');
const legacyRoot=process.platform==='win32'?path.join(process.env.LOCALAPPDATA,'CodexQuietShutdown'):null;
const stateRoot=process.env.QUIETAI_PROFILE?path.join(configRoot,'monitor'):legacyRoot||path.join(configRoot,'monitor');
const defaults={version:4,action:'Sleep',scheduleMode:'Codex',quietMinutes:5,countdownSeconds:60,timerMinutes:60,codexEnabled:null,claudeEnabled:null,codexSessionsOverride:'',claudeHomeOverride:'',excludedWork:[],theme:'system',watchWindows:true,waitForAway:true,minimizeToTray:true,trayHintShown:false,awayMinutes:10,language:'en'};
const THEMES=['system','light','dark'];
function themeBackground(){return nativeTheme.shouldUseDarkColors?'#0A0A0B':'#F3F3F5';}
function loadSettings(){
  settings={...defaults};
  try{settings={...settings,...JSON.parse(fs.readFileSync(settingsPath,'utf8'))};}catch{
    if(legacyRoot)try{const old=JSON.parse(fs.readFileSync(path.join(legacyRoot,'settings.json'),'utf8')); for(const[key,value]of Object.entries(old)){const target=key[0].toLowerCase()+key.slice(1);if(target in defaults)settings[target]=value;}}catch{}
  }
  if(!power.actions.includes(settings.action))settings.action='Sleep';
  if(!THEMES.includes(settings.theme))settings.theme='system';
  nativeTheme.themeSource=settings.theme;
  settings.language=i18n.setLanguage(settings.language); // never guessed from the system locale
  sources=discover(settings);
  settings.codexEnabled??=sources.codex.detected;
  settings.claudeEnabled??=sources.claude.detected;
  save();
}
function save(){if(preview)return;fs.mkdirSync(configRoot,{recursive:true});const temp=settingsPath+'.tmp';fs.writeFileSync(temp,JSON.stringify(settings,null,2));fs.renameSync(temp,settingsPath);}
function options(){return{...settings,excludedWork:[...(settings.excludedWork||[]),...staleWork],codexSessionsOverride:sources.codex.folder,claudeHomeOverride:sources.claude.folder};}
function active(){return ['waiting','idle','countdown','timer','executing'].includes(plan.phase);}
function state(){return{settings,sources,snapshot,plan,error,message,busy,operation,actions:power.actions,actionNames:power.names,platform:process.platform,version:VERSION,update:updateState(),icons:providerIcons,dark:nativeTheme.shouldUseDarkColors,claudeCheck,dismissed:{count:dismissedWork.count,reviewing:manualReview},windows:{...windows,fresh:windowsFresh(),supported:windowsSupported()}};}
// Keep Windows/macOS from idling to sleep while a plan is armed, so the
// computer cannot doze off in the middle of the AI's work.
let blocker=null;
function syncBlocker(){
  const want=active()&&plan.phase!=='executing';
  if(want&&blocker===null)blocker=powerSaveBlocker.start('prevent-app-suspension');
  else if(!want&&blocker!==null){powerSaveBlocker.stop(blocker);blocker=null;}
}
// ——— Activity log ———
// A small local log of what the plan was waiting for, so a plan that didn't fire can be explained
// afterwards. Kept next to the monitor's files (quietai-activity.log, ~2 MB, one older copy).
// No chat content: only phases, counts, item labels, window markers, idle time and power events.
const activityFile=path.join(stateRoot,'quietai-activity.log');
function activity(event,data={}){
  if(preview)return;
  try{
    fs.mkdirSync(stateRoot,{recursive:true});
    try{if(fs.statSync(activityFile).size>2*1024*1024)fs.renameSync(activityFile,activityFile+'.1');}catch{}
    fs.appendFileSync(activityFile,JSON.stringify({t:new Date().toISOString(),event,...data})+'\n');
  }catch{}
}
function holding(){
  const w=snapshot?.work||[];
  return w.slice(0,12).map(x=>`${x.provider}:${x.status}:${String(x.chatTitle||x.label||'').slice(0,40)}`);
}
function winSummary(k){const w=windows[k];return w?{w:w.windows,stops:w.stops.length,named:w.running.length,working:w.working}:null;}
let lastLoggedPhase='',lastHeartbeat=0,lastBeatMono=0;
function logActivity(){
  if(plan.phase!==lastLoggedPhase){activity('phase',{from:lastLoggedPhase||'start',to:plan.phase,clear:!!snapshot?.clear,chats:snapshot?.chatCount||0,holding:holding(),userIdleS:Math.round(userIdleMs()/1000),present:!!plan.present});lastLoggedPhase=plan.phase;}
  const mono=performance.now();
  if(lastBeatMono&&mono-lastBeatMono>120000)activity('gap',{seconds:Math.round((mono-lastBeatMono)/1000),note:'Quiet AI did not run for this long (computer asleep, suspended, or the app was paused).'});
  lastBeatMono=mono;
  if(active()&&Date.now()-lastHeartbeat>=60000){
    lastHeartbeat=Date.now();
    activity('waiting-on',{phase:plan.phase,clear:!!snapshot?.clear,busy,error:error||undefined,chats:snapshot?.chatCount||0,holding:holding(),userIdleS:Math.round(userIdleMs()/1000),windowsFresh:windowsFresh(),claudeWindow:winSummary('claude'),codexWindow:winSummary('codex'),untilS:plan.until?Math.round((plan.until-Date.now())/1000):null});
  }
}

// ——— Is someone using the computer? ———
// Seconds since the last mouse/keyboard/touch input, from the OS (GetLastInputInfo on Windows).
function userIdleMs(){try{const seconds=powerMonitor.getSystemIdleTime();return typeof seconds==='number'&&Number.isFinite(seconds)&&seconds>=0?seconds*1000:null;}catch{return null;}}
function awayMs(){return (Number(settings.awayMinutes)||10)*60000;}
// The window floats on top only during the final countdown, and a countdown banner
// appears on top of everything on every screen (so it's seen whichever monitor you look at).
let onTop=false,overlays=[],countdownNotification=null;
function syncOnTop(){
  const want=plan.phase==='countdown';
  if(want===onTop||!window||window.isDestroyed())return;
  onTop=want;window.setAlwaysOnTop(want,'screen-saver');if(!want){window.flashFrame(false);closeOverlays();dismissCountdownNotification();}
}
function showOverlays(){
  closeOverlays();
  if(process.argv.includes('--capture'))return;
  const {screen}=require('electron');
  for(const display of screen.getAllDisplays()){
    const area=display.workArea,W=Math.min(560,area.width-40),H=120;
    const o=new BrowserWindow({x:Math.round(area.x+(area.width-W)/2),y:Math.round(area.y+Math.max(24,area.height*0.12)),width:W,height:H,frame:false,resizable:false,movable:false,minimizable:false,maximizable:false,fullscreenable:false,skipTaskbar:true,alwaysOnTop:true,focusable:false,show:false,backgroundColor:'#121214',title:'Quiet AI countdown',webPreferences:{preload:path.join(__dirname,'preload.js'),contextIsolation:true,sandbox:true,nodeIntegration:false}});
    o.setAlwaysOnTop(true,'screen-saver');o.setVisibleOnAllWorkspaces?.(true,{visibleOnFullScreen:true});o.on('page-title-updated',e=>e.preventDefault());
    o.webContents.setWindowOpenHandler(()=>({action:'deny'}));o.webContents.on('will-navigate',e=>e.preventDefault());
    o.loadFile(path.join(__dirname,'countdown.html'));
    o.once('ready-to-show',()=>{if(!o.isDestroyed()){o.showInactive();o.moveTop();}});
    o.on('closed',()=>{overlays=overlays.filter(x=>x!==o);});
    overlays.push(o);
  }
  try{shell.beep();}catch{}
}
function closeOverlays(){for(const o of overlays.splice(0))try{if(!o.isDestroyed())o.destroy();}catch{}}
// ——— System tray ———
// Minimizing hides the window to the tray (notification area); the tray icon shows the plan
// status on hover, opens the window on click, and has Open / Stop plan / Quit on right-click.
let tray=null,trayTip='',trayMenuKey='';
function showWindow(){
  if(!window||window.isDestroyed())return;
  if(window.isMinimized())window.restore();
  window.show();window.focus();
}
function hideToTray(){
  if(!window||window.isDestroyed())return;
  if(!tray){window.minimize();return;}
  window.hide();
  if(!settings.trayHintShown){
    if(Notification.isSupported()){
      const note=new Notification({title:tr('tray.hintTitle'),body:tr(process.platform==='darwin'?'tray.hintMac':'tray.hint'),silent:true});
      note.on('show',()=>{settings.trayHintShown=true;save();});note.on('failed',(_event,reason)=>activity('notification-failed',{kind:'tray-hint',reason:String(reason||'').slice(0,200)}));note.on('click',showWindow);note.show();
    }
  }
}
function trayStatus(){
  const left=()=>{const s=Math.max(0,Math.ceil((plan.until-Date.now())/1000));return Math.floor(s/60)+':'+String(s%60).padStart(2,'0');};
  const chats=snapshot?.chatCount||0;
  const name=actionName(settings.action);
  switch(plan.phase){
    case 'countdown':return tr(process.platform==='darwin'?'tray.countdownMac':'tray.countdown',{action:name,time:left()});
    case 'timer':return plan.present?tr('tray.timerPresent'):tr('plan.timerLine',{action:name,duration:left()});
    case 'idle':return tr(plan.present?'tray.idlePresent':'tray.confirming');
    case 'waiting':return chats?tr('tray.armedRunning',{count:chats}):tr('tray.armed');
    case 'executing':return name+'…';
    default:return chats?tr('count.chatsRunning',{count:chats}):tr('tray.notArmed');
  }
}
function actionName(action){return i18n.has('action.'+action)?tr('action.'+action):power.names[action]||action;}
function syncTray(){
  if(!tray)return;
  const tip='Quiet AI — '+trayStatus();
  if(tip!==trayTip){trayTip=tip;try{tray.setToolTip(tip);}catch{}}
  if(process.platform!=='win32'&&process.platform!=='darwin'){
    const key=JSON.stringify([plan.phase,active(),i18n.language()]);
    if(key!==trayMenuKey){trayMenuKey=key;tray.setContextMenu(trayMenu());}
  }
}
function trayMenu(){
  return Menu.buildFromTemplate([
    ...(process.platform==='darwin'?[{label:trayStatus(),enabled:false},{type:'separator'}]:[]),
    {label:tr('tray.open'),click:showWindow},
    {label:tr(plan.phase==='countdown'?'tray.cancelCountdown':'tray.stopPlan'),enabled:active()&&plan.phase!=='executing',click:()=>{reset();message=tr('msg.planStopped');broadcast();}},
    {type:'separator'},
    {label:tr('tray.quit'),click:()=>app.quit()}
  ]);
}
function createTray(){
  try{
    const file=path.join(__dirname,process.platform==='darwin'?'trayTemplate.png':process.platform==='win32'?'icon.ico':'icon.png');
    let image=nativeImage.createFromPath(file);
    if(image.isEmpty())return;
    if(process.platform!=='win32'&&process.platform!=='darwin')image=image.resize({width:22,height:22,quality:'best'});
    if(process.platform==='darwin')image.setTemplateImage(true);
    tray=new Tray(image);
    if(process.env.QUIETAI_TEST_HOOKS)global.__quietTray={tray,menu:trayMenu,tip:()=>trayTip};
    tray.setToolTip('Quiet AI');
    tray.on('click',()=>{if(process.platform==='darwin')tray.popUpContextMenu(trayMenu());else if(window.isVisible()&&!window.isMinimized())hideToTray();else showWindow();});
    tray.on('right-click',()=>tray.popUpContextMenu(trayMenu()));
    if(process.platform!=='win32'&&process.platform!=='darwin')tray.setContextMenu(trayMenu());
  }catch{tray=null;}
}
function announceCountdown(){
  if(!window||window.isDestroyed())return;
  if(window.isMinimized())window.restore();
  // Float above everything (without stealing the keyboard) so someone still at the PC sees it.
  window.setAlwaysOnTop(true,'screen-saver');window.showInactive();window.moveTop();window.flashFrame(true);
  showOverlays();
  if(Notification.isSupported()){
    const finished=tr(plan.timer?'notify.timerFinished':'notify.aiFinished');
    const note=new Notification({title:tr('notify.countdownTitle',{action:actionName(settings.action),count:settings.countdownSeconds}),body:finished+' '+tr(settings.waitForAway?'notify.moveOrClick':'notify.click'),silent:false});
    countdownNotification=note;
    note.on('failed',(_event,reason)=>activity('notification-failed',{kind:'countdown',reason:String(reason||'').slice(0,200)}));
    note.on('click',()=>{if(plan.phase==='countdown'){reset();message=tr('msg.countdownCancelled');broadcast();}showWindow();});note.show();
  }
}
// Show the real Claude and Codex icons by reading them from the apps installed
// on this computer (Microsoft Store packages, classic installs, or macOS bundles).
let providerIcons={codex:null,claude:null};
function iconFromFile(file){
  try{if(!fs.existsSync(file))return null;const image=nativeImage.createFromPath(file);return image.isEmpty()?null:image.resize({width:64,height:64,quality:'best'}).toDataURL();}catch{return null;}
}
async function iconFromApp(file){
  try{if(!fs.existsSync(file))return null;const image=await app.getFileIcon(file,{size:process.platform==='darwin'?'normal':'large'});return image.isEmpty()?null:image.toDataURL();}catch{return null;}
}
function listStorePackages(){
  return new Promise(resolve=>{
    const shell=path.join(process.env.SystemRoot||'C:\\Windows','System32','WindowsPowerShell','v1.0','powershell.exe');
    const script="Get-AppxPackage | Where-Object { $_.Name -match '^(Claude|OpenAI\\.Codex|OpenAI\\.ChatGPT)' } | ForEach-Object { $_.Name + '|' + $_.InstallLocation }";
    execFile(shell,['-NoProfile','-NonInteractive','-Command',script],{windowsHide:true,timeout:10000},(err,stdout)=>{
      if(err||!stdout)return resolve([]);
      resolve(stdout.split(/\r?\n/).map(line=>line.trim().split('|')).filter(parts=>parts.length===2&&parts[1]));
    });
  });
}
// Windows ships Store-app logos in two "unplated" variants: one for dark backgrounds
// (usually a light glyph) and one for light backgrounds ("lightunplated", usually a
// dark glyph). Single-colour logos such as Codex's vanish on the wrong background, so
// keep both and let the renderer pick the one matching the current theme.
const ICON_SIZES=[64,96,48,256,40,32];
const DARK_ASSETS=[...ICON_SIZES.map(s=>`Square44x44Logo.targetsize-${s}_altform-unplated.png`),...ICON_SIZES.map(s=>`Square44x44Logo.targetsize-${s}.png`),'StoreLogo.scale-400.png','StoreLogo.scale-200.png','Square44x44Logo.scale-200.png','StoreLogo.png','Square44x44Logo.png','icon.png'];
const LIGHT_ASSETS=[...ICON_SIZES.map(s=>`Square44x44Logo.targetsize-${s}_altform-lightunplated.png`),...DARK_ASSETS];
let iconReport={};
function mostlyWhite(url){
  try{
    const img=nativeImage.createFromDataURL(url),bmp=img.toBitmap();let n=0,light=0;
    for(let i=0;i<bmp.length;i+=4){if(bmp[i+3]<128)continue;n++;const l=(0.0722*bmp[i]+0.7152*bmp[i+1]+0.2126*bmp[i+2])/255;if(l>0.85)light++;}
    return n>0&&light/n>0.8;
  }catch{return false;}
}
function iconFromAssets(location,names){
  for(const folder of ['assets','Assets','images'])for(const file of names){
    const url=iconFromFile(path.join(location,folder,file));
    if(url)return{url,file:folder+'/'+file};
  }
  return null;
}
async function findProviderIcons(){
  const found={codex:null,claude:null};
  if(process.platform==='win32'){
    const packages=(await listStorePackages()).sort((a,b)=>(a[0]==='OpenAI.Codex'?-1:0)-(b[0]==='OpenAI.Codex'?-1:0));
    iconReport.packages=packages.map(p=>p[0]);
    for(const [name,location] of packages){
      const key=name.startsWith('Claude')?'claude':'codex';
      if(found[key])continue;
      const dark=iconFromAssets(location,DARK_ASSETS),light=iconFromAssets(location,LIGHT_ASSETS);
      if(dark||light){found[key]={dark:(dark||light).url,light:(light||dark).url};found[key].plateOnLight=mostlyWhite(found[key].light);iconReport[key]=name+' '+(dark||light).file+(light&&light.file!==dark?.file?' / '+light.file:'');}
    }
    const local=process.env.LOCALAPPDATA||'';
    for(const [key,files] of [['claude',[path.join(local,'AnthropicClaude','claude.exe'),path.join(local,'Programs','Claude','Claude.exe')]],['codex',[path.join(local,'Programs','Codex','Codex.exe'),path.join(local,'Programs','ChatGPT','ChatGPT.exe')]]])
      for(const file of files)if(!found[key]){const url=await iconFromApp(file);if(url){found[key]={dark:url,light:url};iconReport[key]=path.basename(file);}}
  }else if(process.platform==='darwin'){
    const macIcons=require('./mac-icons');
    for(const [key,names,ids] of [['claude',['Claude'],['com.anthropic.claudefordesktop']],['codex',['Codex','ChatGPT'],['com.openai.codex','com.openai.chat']]])
      for(const bundle of await macIcons.bundles(names,ids))
        if(!found[key]){const url=await macIcons.icon(bundle,nativeImage)||await iconFromApp(bundle);if(url){found[key]={dark:url,light:url,plateOnLight:mostlyWhite(url)};iconReport[key]=path.basename(bundle);}}
  }
  for(const key of ['codex','claude'])if(!found[key])iconReport[key]='not found';
  providerIcons=found;broadcast();
}
function broadcast(){syncBlocker();syncOnTop();syncTray();logActivity();const st=state();if(window&&!window.isDestroyed())window.webContents.send('quiet:state',st);for(const o of overlays)if(!o.isDestroyed())o.webContents.send('quiet:state',st);}
function reset(){plan={phase:'disarmed',until:null,started:null};lastRevision=null;dismissCountdownNotification();}
function dismissCountdownNotification(){try{countdownNotification?.close();}catch{}countdownNotification=null;}
async function scan(){
  if(busy||preview)return;
  busy=true; broadcast();
  try{
    let result=await agent.request('scan',options());
    if(findStaleCodexTurns(result.snapshot))result=await agent.request('scan',options());
    rawSnapshot=normalize(result.snapshot);snapshot=applyWindows(dismissedWork.apply(rawSnapshot));scanSerial++;error='';
    if(!manualReview&&['waiting','idle','countdown'].includes(plan.phase)&&!plan.timer){
      const changed=lastRevision!==null&&lastRevision!==snapshot.revision;lastRevision=snapshot.revision;
      if(!snapshot.clear||changed){plan={phase:'waiting',until:null,started:null};}
      if(snapshot.clear&&plan.phase==='waiting'){plan={phase:'idle',started:Date.now(),until:Date.now()+settings.quietMinutes*60000};}
    }
  }catch(ex){error=ex.message;activity('scan-error',{message:ex.message});if(['waiting','idle','countdown'].includes(plan.phase)&&!plan.timer)plan={phase:'waiting',until:null,started:null};}
  finally{busy=false;broadcast();}
}

// ——— Codex turns that ended without a completion record ———
// Codex normally writes task_complete (or an abort record) when a turn ends. When a turn is
// interrupted, crashes or the app restarts mid-turn, nothing is written and the turn would
// look "running" for as long as the Codex app keeps that chat loaded (hours). Two safe signals
// retire such turns:
//  1. Superseded: a newer turn started in the same chat. A Codex chat runs one turn at a time,
//     so the older one is over.
//  2. Stalled (Codex desktop app only): its log has not changed for STALL_LOG_MS and the Codex
//     app window has shown no Stop button or "Working" marker for STALL_WINDOW_MS. Terminal/IDE
//     sessions are never retired this way, because their work isn't visible in the app window.
// Retired turns are passed to the monitor as excluded work, so counts and rows stay consistent.
const STALL_LOG_MS=+process.env.QUIETAI_STALL_LOG_MS||120000,STALL_WINDOW_MS=+process.env.QUIETAI_STALL_WINDOW_MS||60000; // env: tests only
const staleWork=new Set(),staleReasons={},originators={};
function codexTurn(item){
  const key=String(item?.key||'');if(!key.startsWith('Codex:')||item.status!=='Running')return null;
  const cut=key.lastIndexOf(':');const file=key.slice(6,cut),turn=key.slice(cut+1);
  if(!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(turn)||!/\.jsonl$/i.test(file))return null;
  return {key,file,turn,started:Date.parse(item.lastEventUtc)||0};
}
function originator(file){
  if(file in originators)return originators[file];
  let value='';
  try{const fd=fs.openSync(file,'r');try{const buf=Buffer.alloc(65536);const n=fs.readSync(fd,buf,0,buf.length,0);const m=/"originator"\s*:\s*"([^"]*)"/.exec(buf.toString('utf8',0,n));value=m?m[1]:'';}finally{fs.closeSync(fd);}}catch{return '';}
  return originators[file]=value;
}
// Last turn start/completion record in a Codex log, read backwards from the end (cached by size).
const lifecycleCache={};
function lastLifecycle(file){
  let st;try{st=fs.statSync(file);}catch{return null;}
  const hit=lifecycleCache[file];if(hit&&hit.size===st.size&&hit.mtime===st.mtimeMs)return hit.value;
  let value=null,fd;
  try{
    fd=fs.openSync(file,'r');
    const CHUNK=1<<20,LIMIT=Math.min(st.size,8*CHUNK);let pos=st.size,carry='';
    const re=/"type":"event_msg".*?"type":"(task_started|task_complete|turn_aborted|task_aborted|turn_cancelled|task_cancelled)".*?"turn_id":"([0-9a-f-]{36})"/i;
    while(pos>0&&st.size-pos<LIMIT&&!value){
      const len=Math.min(CHUNK,pos);pos-=len;
      const buf=Buffer.alloc(len);fs.readSync(fd,buf,0,len,pos);
      const lines=(buf.toString('utf8')+carry).split('\n');carry=pos>0?lines.shift():'';
      for(let i=lines.length-1;i>=0;i--){
        const line=lines[i];if(line.length>8192||line.indexOf('"event_msg"')<0)continue;
        const m=re.exec(line);if(m){value={type:m[1],turn:m[2]};break;}
      }
    }
  }catch{value=null;}finally{if(fd!==undefined)try{fs.closeSync(fd);}catch{}}
  lifecycleCache[file]={size:st.size,mtime:st.mtimeMs,value};
  return value;
}
function findStaleCodexTurns(snap){
  const turns=(snap?.codex?.work||[]).map(codexTurn).filter(Boolean).filter(t=>!staleWork.has(t.key));
  let added=0;const retire=(t,why)=>{staleWork.add(t.key);staleReasons[t.key]=why;added++;activity('codex-turn-retired',{why,turn:t.turn,chat:path.basename(t.file),startedUtc:new Date(t.started).toISOString()});};
  const byFile={};for(const t of turns)(byFile[t.file]=byFile[t.file]||[]).push(t);
  for(const list of Object.values(byFile)){
    list.sort((a,b)=>b.started-a.started||(b.turn>a.turn?1:-1));
    for(const t of list.slice(1))retire(t,'superseded');
    // The newest outstanding turn is also over if the chat's log has since recorded a
    // different turn (or this turn's own completion). Read straight from the log's tail, so a
    // turn the monitor still holds from hours ago doesn't need the app window to be cleared.
    const t=list[0];if(staleWork.has(t.key)||Date.now()-t.started<60000)continue;
    const last=lastLifecycle(t.file);
    if(last&&(last.turn!==t.turn||last.type!=='task_started'))retire(t,'superseded');
  }
  const quiet=windowsSupported()&&settings.watchWindows&&windowsFresh()&&windows.codex&&windows.codex.windows>0&&!windows.codex.busy&&windowQuietSince.codex&&Date.now()-windowQuietSince.codex>=STALL_WINDOW_MS;
  if(quiet){
    for(const list of Object.values(byFile)){
      const t=list[0];if(staleWork.has(t.key))continue;
      if(!/codex desktop/i.test(originator(t.file)))continue;
      let idle=0;try{idle=Date.now()-fs.statSync(t.file).mtimeMs;}catch{continue;}
      if(idle>=STALL_LOG_MS)retire(t,'stalled');
    }
  }
  return added>0;
}
// Wait for an in-flight scan instead of rejecting the user's click.
async function waitForScan(limit=30000){
  const end=Date.now()+limit;
  while(busy&&Date.now()<end)await new Promise(resolve=>setTimeout(resolve,100));
  if(busy)throw new Error(tr('error.monitorBusy'));
}
// Once the hook is installed, "no Claude Code event yet" means no hooked Claude Code
// session has run. Treat that as connected with nothing running, so a Codex-only
// evening still finishes. Sessions that were already open before connecting are not
// visible until restarted (the app says so after connecting).
const FIRST_EVENT='Waiting for the first real Claude hook event';
function normalize(snap){
  try{
    const c=snap?.claude;
    if(!c||!c.enabled||c.connected||c.work?.length!==1)return snap;
    const item=c.work[0];
    if(item.key!=='Claude:connection'||!String(item.reason||'').startsWith(FIRST_EVENT))return snap;
    const claude={...c,connected:true,work:[],uncertain:0,clear:true,awaitingFirstEvent:true,detail:'Connected. No Claude Code session has run since connecting.'};
    const work=(snap.work||[]).filter(w=>w.key!=='Claude:connection');
    const uncertain=Math.max(0,(snap.uncertain||0)-1);
    // Overall clear = Codex clear and Claude clear (now true); Claude is enabled, so at least one provider is on.
    return {...snap,claude,work,uncertain,clear:!!snap.codex?.clear};
  }catch{return snap;}
}

// ——— Claude Code connection check ———
// Confirms that Quiet AI's hook is present in the Claude settings file and that the
// exact hook command works, by running it once with a synthetic SessionStart event.
function isOurHook(command){
  if(typeof command!=='string')return false;
  if(command.includes('QuietAI.Agent')&&/\shook\s/.test(command))return true;
  const i=command.indexOf('-EncodedCommand ');
  if(i<0)return command.includes('ClaudeHook.ps1');
  try{return Buffer.from(command.slice(i+16).trim(),'base64').toString('utf16le').includes('ClaudeHook.ps1');}catch{return false;}
}
function runHook(command,input,timeout=20000){
  return new Promise(resolve=>{
    const {exec}=require('node:child_process');
    const child=exec(command,{timeout,windowsHide:true},(err,stdout,stderr)=>resolve({code:err?(err.code??1):0,stderr:String(stderr||'').trim().slice(0,400)}));
    child.stdin.on('error',()=>{});child.stdin.end(JSON.stringify(input));
  });
}
async function checkClaude(){
  const settingsFile=path.join(sources.claude.folder,'settings.json');
  const r={settingsFile,found:false,events:[],disabled:false,ran:false,ok:false,problem:''};
  // The problem is kept in English (status summary, tests) and as a key the interface translates.
  const problem=(key,params)=>{r.problemKey=key;r.problemParams=params;r.problem=tr(key,params,'en');};
  let json;
  try{json=JSON.parse(fs.readFileSync(settingsFile,'utf8'));}catch(ex){fs.existsSync(settingsFile)?problem('check.unreadable',{error:ex.message}):problem('check.noFile');return r;}
  r.disabled=json.disableAllHooks===true;
  let command=null;
  for(const [event,groups] of Object.entries(json.hooks||{}))
    for(const group of Array.isArray(groups)?groups:[])for(const handler of Array.isArray(group?.hooks)?group.hooks:[])
      if(isOurHook(handler?.command)){if(!r.events.includes(event))r.events.push(event);if(event==='SessionStart'||!command)command=handler.command;}
  r.found=r.events.length>0;
  if(!r.found){problem('check.notInFile',{file:settingsFile});return r;}
  if(r.disabled){problem('check.disabled');return r;}
  const session='quietai-selftest-'+Date.now();
  const eventsDir=path.join(stateRoot,'claude-events'),log=path.join(eventsDir,session+'.jsonl');
  const result=await runHook(command,{hook_event_name:'SessionStart',session_id:session,source:'startup',cwd:os.homedir()});
  r.ran=true;r.exitCode=result.code;
  r.ok=fs.existsSync(log);
  for(const f of [log,path.join(eventsDir,session+'.collector-lock')])try{fs.rmSync(f,{force:true});}catch{}
  if(!r.ok)result.stderr?problem('check.notRecordedDetail',{error:result.stderr}):problem('check.notRecorded');
  return r;
}

// ——— App window watcher ———
// Tracks work shown in the Claude and Codex desktop apps, wherever it runs (local,
// cloud, Chat, Cowork, Code): a child process reports "Stop…" buttons it sees in their
// windows via UI Automation (uia-watch.ps1). A false positive only keeps a plan waiting.
const {spawn}=require('node:child_process');
let windows={claude:null,codex:null,at:0,error:'',running:false};
let windowSince={claude:0,codex:0},titleSince={},windowQuietSince={claude:0,codex:0};
function startWindowWatcher(){
  let cmd,args,opts={windowsHide:true,stdio:['ignore','pipe','pipe']};
  if(process.env.QUIETAI_WINDOW_WATCHER){cmd=process.execPath;args=[process.env.QUIETAI_WINDOW_WATCHER];opts.env={...process.env,ELECTRON_RUN_AS_NODE:'1'};}
  else if(process.platform==='win32'){cmd=path.join(process.env.SystemRoot||'C:\\Windows','System32','WindowsPowerShell','v1.0','powershell.exe');args=['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',path.join(__dirname,'uia-watch.ps1')];}
  else return;
  let child;
  try{child=spawn(cmd,args,opts);}catch(ex){windows.error='Window watcher could not start: '+ex.message;return;}
  windows.running=true;windowWatcher=child;
  let buffer='';
  child.stdout.on('data',chunk=>{
    buffer+=chunk;let i;
    while((i=buffer.indexOf('\n'))>=0){
      const line=buffer.slice(0,i).trim();buffer=buffer.slice(i+1);
      if(!line)continue;
      try{
        const r=JSON.parse(line),now=Date.now();
        for(const key of ['claude','codex']){
          const v=r[key]||{};const arr=x=>Array.isArray(x)?x.map(String):(x?[String(x)]:[]);
          // Only the Claude sidebar names chats ("Running <title>"); Codex "Running …" items are commands.
          // tabs: app modes not on screen whose switcher reads "<mode>, working" (Claude: "Chat and Cowork", "Code").
          const w={windows:v.windows|0,stops:arr(v.stops),running:key==='claude'?arr(v.running):[],working:(v.working|0)+(key==='claude'?0:arr(v.running).length),tabs:arr(v.tabs)};
          w.busy=w.stops.length>0||w.running.length>0||w.working>0||w.tabs.length>0;
          windows[key]=w;
          if(w.busy&&!windowSince[key])windowSince[key]=now;if(!w.busy)windowSince[key]=0;
          if(!w.busy&&w.windows>0){if(!windowQuietSince[key])windowQuietSince[key]=now;}else windowQuietSince[key]=0;
          for(const t of w.running)if(!titleSince[key+':'+t])titleSince[key+':'+t]=now;
          for(const t of w.tabs)if(!titleSince[key+':tab:'+t])titleSince[key+':tab:'+t]=now;
          // A chat that stops showing "Running" starts a fresh timer if it runs again later.
          for(const k of Object.keys(titleSince)){
            if(!k.startsWith(key+':'))continue;const rest=k.slice(key.length+1);
            if(rest.startsWith('tab:')?!w.tabs.includes(rest.slice(4)):!w.running.includes(rest))delete titleSince[k];
          }
        }
        windows.at=performance.now();windows.error='';
      }catch{}
    }
  });
  child.stderr.on('data',()=>{});
  child.on('exit',()=>{windows.running=false;windowWatcher=null;if(!quitting)setTimeout(startWindowWatcher,5000);});
  child.on('error',ex=>{windows.error='Window watcher stopped: '+ex.message;});
}
let windowWatcher=null,quitting=false;
const {performance}=require('node:perf_hooks');
const watcherStarted=performance.now();
function windowsFresh(){return windows.running&&windows.at>0&&performance.now()-windows.at<12000;}
function windowsSupported(){return process.platform==='win32'||!!process.env.QUIETAI_WINDOW_WATCHER;}
function applyWindows(snap){
  if(!snap)return snap;
  snap={...snap,work:[...(snap.work||[])],chats:[...(snap.chats||[])]};
  const sig=settings.watchWindows?['claude','codex'].map(k=>{const w=windows[k]||{};return [(w.stops||[]).length,(w.running||[]).join('|'),w.working|0].join(':');}).join(','):'off';
  if(sig!==lastWindowSig){lastWindowSig=sig;windowRevision++;}
  snap.revision=String(snap.revision)+'/'+windowRevision; // stable format, changes only with what the windows show
  if(!settings.watchWindows||!windowsSupported())return snap;
  if(!windowsFresh()){
    // Watching is on but the watcher isn't reporting: we can't see app work, so don't assume it's clear.
    if(performance.now()-watcherStarted>15000){
      const item={key:'Windows:watcher',provider:'Claude',session:'app-window',label:'App windows can’t be checked',status:'Uncertain',reason:windows.error||'The window watcher is not responding. Turn off “Watch the Claude and Codex apps” in Settings to ignore app windows.',lastEventUtc:new Date().toISOString()};
      snap.work.push(item);snap.uncertain=(snap.uncertain||0)+1;snap.clear=false;
    }
    return snap;
  }
  for(const [key,Name,app] of [['claude','Claude','Claude app'],['codex','Codex','Codex app']]){
    const p=snap[key];if(!p||!settings[key+'Enabled'])continue;
    const w=windows[key];
    const q={...p,work:[...(p.work||[])],chats:[...(p.chats||[])],windowWatch:true};
    // Without hooks/session logs the provider can still be watched through its app window.
    const setupOnly=item=>item.key===Name+':connection'&&/Connect Claude|No Claude events|sessions folder is missing|Waiting for the first/i.test(String(item.reason||''));
    if(!q.connected&&q.work.length&&q.work.every(setupOnly)){
      const drop=new Set(q.work.map(x=>x.key));
      q.work=[];q.connected=true;q.viaWindowOnly=true;q.uncertain=0;
      snap.work=snap.work.filter(x=>!drop.has(x.key));snap.uncertain=Math.max(0,(snap.uncertain||0)-drop.size);
    }
    if(w&&w.busy){
      const seen=w.stops[0]||(w.running.length?'Running':w.tabs.length?w.tabs[0]+', working':'Working');
      const item={key:Name+':window',provider:Name,session:'app-window',label:app+' · working',status:'Running',reason:'The '+app+' shows “'+seen+'”.',lastEventUtc:new Date().toISOString()};
      q.work.push(item);snap.work.push(item);
      // Rows: one per named running chat from the Claude sidebar; otherwise one per busy task.
      const known=new Set((q.chats||[]).map(c=>String(c.title).toLowerCase()));
      let rows=w.running.filter(t=>!known.has(t.toLowerCase())).map(t=>({provider:Name,session:'app:'+t,title:t,promptCount:1,startedUtc:new Date(titleSince[key+':'+t]||windowSince[key]||Date.now()).toISOString(),fromWindow:true}));
      // A mode that isn't on screen but has running work (e.g. a cloud Cowork task while the Code tab
      // is open). Its chats aren't listed, so it gets one row. A busy Code tab is skipped when Claude
      // Code sessions are already listed from the hook/live status, so they aren't counted twice.
      // "Stop response" belongs to a Chat/Cowork reply on screen (Claude Code's button is just "Stop"),
      // so it's separate work even when Claude Code sessions are listed; give it a row unless the
      // sidebar already names what's running.
      if(key==='claude'&&!w.running.length&&w.stops.some(s=>/^stop response/i.test(s)))
        rows.push({provider:Name,session:'app-reply',title:app+' · Chat/Cowork working',promptCount:1,startedUtc:new Date(windowSince[key]||Date.now()).toISOString(),fromWindow:true});
      for(const tab of w.tabs){
        if(/^code\b/i.test(tab)&&(q.chats||[]).some(c=>!c.fromWindow))continue;
        rows.push({provider:Name,session:'app-tab:'+tab,title:app+' · '+tab+' working',promptCount:1,startedUtc:new Date(titleSince[key+':tab:'+tab]||windowSince[key]||Date.now()).toISOString(),fromWindow:true});
      }
      if(!rows.length&&!(q.chats||[]).length){
        const n=Math.max(1,key==='codex'?w.working:0);
        rows=[{provider:Name,session:'app-window',title:n>1?app+' · '+n+' tasks working':app+' · working',promptCount:1,startedUtc:new Date(windowSince[key]||Date.now()).toISOString(),fromWindow:true}];
      }
      for(const chat of rows){q.chats.push(chat);snap.chats.push(chat);}
      q.chatCount=(q.chatCount||0)+rows.length;snap.chatCount=(snap.chatCount||0)+rows.length;
      q.running=(q.running||0)+1;snap.running=(snap.running||0)+1;
    }
    q.clear=!q.enabled||(q.connected&&q.work.length===0&&!(q.chats||[]).length&&!q.backgroundRunning);
    snap[key]=q;
  }
  snap.clear=!!snap.codex?.clear&&!!snap.claude?.clear&&(!!snap.codex?.enabled||!!snap.claude?.enabled);
  return snap;
}
let lastWindowSig='',windowRevision=0;
let actionInProgress=false;
function waitForPresence(unavailable=false){
  dismissCountdownNotification();
  const timer=plan.timer;
  plan=timer?{phase:'timer',started:plan.started,until:Date.now(),present:true}:{phase:'idle',started:Date.now(),until:Date.now()+awayMs(),present:true};
  message=tr(unavailable?'msg.cantVerifyIdle':'msg.userPresent');
  broadcast();
}
async function tick(){
  if(actionInProgress||manualReview)return;
  const idle=settings.waitForAway?userIdleMs():null;
  if(active()&&settings.waitForAway&&idle===null){
    if(plan.phase==='countdown')waitForPresence(true);
    else{message=tr('msg.cantVerifyIdle');broadcast();}
    return;
  }
  // Someone touched the mouse or keyboard during the final countdown: don't act under them.
  if(plan.phase==='countdown'&&settings.waitForAway&&idle+400<Date.now()-plan.started){waitForPresence();return;}
  if(plan.until&&Date.now()>=plan.until){
    if(plan.phase==='timer'||plan.phase==='idle'){
      if(plan.phase==='idle'&&(busy||error||!snapshot?.clear))return;
      // Only act once nobody has used the mouse or keyboard for the quiet period.
      if(settings.waitForAway){
        if(idle<awayMs()){plan={...plan,until:Date.now()+Math.max(1000,awayMs()-idle),present:true};broadcast();return;}
      }
      plan={phase:'countdown',started:Date.now(),until:Date.now()+settings.countdownSeconds*1000,timer:settings.scheduleMode==='Timer'};announceCountdown();
    }else if(plan.phase==='countdown'){
      if(!plan.timer){
        if(busy)return;
        await scan();
        if(manualReview||plan.phase!=='countdown'||error||!snapshot?.clear||Date.now()-Date.parse(snapshot.checkedUtc)>3000)return;
      }
      if(settings.waitForAway){
        const freshIdle=userIdleMs();
        if(freshIdle===null||freshIdle<awayMs()||freshIdle+400<Date.now()-plan.started){waitForPresence(freshIdle===null);return;}
      }
      const action=settings.action;reset(); actionInProgress=true;plan.phase='executing';broadcast();
      try{await power.perform(action);message=tr('msg.requested',{action:actionName(action)});plan.phase='completed';}
      catch(ex){error=tr('error.actionFailed',{error:i18n.monitorText(ex.message)});plan.phase='error';}
      finally{actionInProgress=false;}
    }
  }
  broadcast();
}
// Manual exclusions live only in this app process. The monitor continues reading
// every record; a changed source-generation token automatically restores the row.
function restartManualWait(){
  if(plan.phase==='countdown'&&plan.timer){reset();message=tr('msg.timerReviewStopped');}
  else if(['waiting','idle','countdown'].includes(plan.phase)&&!plan.timer){plan={phase:'waiting',until:null,started:null};lastRevision=null;dismissCountdownNotification();}
}
async function freshManualEntry(provider,session,token){
  await waitForScan();const serial=scanSerial;await scan();
  const age=Date.now()-Date.parse(rawSnapshot?.checkedUtc);
  if(scanSerial===serial||error||!Number.isFinite(age)||age<0||age>3000)throw new Error(tr('error.cannotVerifyActivity'));
  const entry=inspect(rawSnapshot,provider,session);
  if(!entry||entry.token!==token)throw new Error(tr('error.entryChanged'));
  return entry;
}
async function dismissChat(provider,session,token){
  if(manualReview||actionInProgress||quitting)throw new Error(tr('error.cannotReview'));
  manualReview=true;restartManualWait();broadcast();
  try{
    const entry=await freshManualEntry(provider,session,token);
    const choice=await dialog.showMessageBox(window,{type:'warning',title:tr('dismiss.title'),
      buttons:[tr('dismiss.cancel'),tr('dismiss.confirm')],defaultId:0,cancelId:0,noLink:true,
      checkboxLabel:tr('dismiss.checkbox'),checkboxChecked:false,
      message:tr('dismiss.message',{count:entry.promptCount,provider}),
      detail:tr('dismiss.detail',{action:actionName(settings.action)})});
    if(choice.response!==1)return;
    // Native button-key mappings vary. Return alone must never grant this override.
    if(choice.checkboxChecked!==true){message=tr('msg.dismissNotAcknowledged');return;}
    if(quitting||window.isDestroyed()||actionInProgress)throw new Error(tr('error.closingOrActing'));
    await freshManualEntry(provider,session,token);
    dismissedWork.dismiss(rawSnapshot,provider,session,token);
    snapshot=applyWindows(dismissedWork.apply(rawSnapshot));
    message=tr('msg.dismissed');
  }finally{restartManualWait();manualReview=false;broadcast();}
}
function restoreDismissed(){
  if(manualReview||actionInProgress)throw new Error(tr('error.waitForReview'));
  const count=dismissedWork.restore();
  if(count){snapshot=applyWindows(dismissedWork.apply(rawSnapshot));restartManualWait();message=tr('msg.restored');}
  broadcast();
}
function chatMenu(payload){
  if(manualReview||actionInProgress)throw new Error(tr('error.cannotReview'));
  const chat=snapshot?.chats?.find(c=>c.provider===payload.provider&&c.session===payload.session);
  if(!chat)throw new Error(tr('error.notRunning'));
  const entry=inspect(rawSnapshot,chat.provider,chat.session);
  const allowed=!!entry&&!chat.fromWindow&&chat.dismissible===true&&payload.token===entry.token;
  const menu=Menu.buildFromTemplate([{label:tr('dismiss.menu'),enabled:allowed,click:()=>{
    if(!allowed)return;
    dismissChat(chat.provider,chat.session,entry.token).catch(ex=>{message=i18n.monitorText(ex.message);broadcast();});
  }},...(!allowed?[{label:tr('dismiss.cannotVerify'),enabled:false}]:[]),
    {type:'separator'},{label:tr('dismiss.restoreAll'),enabled:dismissedWork.count>0,click:()=>{try{restoreDismissed();}catch(ex){message=ex.message;broadcast();}}}]);
  menu.popup({window});
}

// ——— App updates ———
// Checks GitHub Releases quietly on start and every 6 hours; installing only happens on a click,
// and never while a plan is armed (the app restarts to finish).
let update={phase:'idle',info:null,progress:0,error:''};
function updateState(){const i=update.info;return{phase:update.phase,progress:update.progress,error:update.error,available:!!i?.available,latest:i?.latest||'',page:i?.page||'',configured:/^[\w.-]+\/[\w.-]+$/.test(updater.REPO)};}
async function checkUpdate(manual){
  if(preview||['checking','downloading','installing'].includes(update.phase))return;
  update={...update,phase:'checking',error:''};if(manual)broadcast();
  try{update.info=await updater.check();update.phase='idle';activity('update-check',{latest:update.info.latest,available:update.info.available});}
  catch(ex){update.phase='idle';if(manual)update.error=ex.message;}
  if(manual)message=update.error?'':update.info?.available?tr('msg.updateAvailable',{version:update.info.latest}):tr('msg.latest');
  broadcast();
}
async function installUpdate(){
  if(!update.info?.available)throw new Error(tr('error.noUpdate'));
  if(active())throw new Error(tr('error.stopBeforeUpdate'));
  if(['checking','downloading','installing'].includes(update.phase))throw new Error(tr('error.alreadyWorking'));
  const place=updater.installation();
  if(place.problem)throw new Error(place.problem);
  if(!place.writable){shell.openExternal(update.info.page);throw new Error(tr('error.cantWrite'));}
  update={...update,phase:'downloading',progress:0,error:''};broadcast();
  try{
    const unpacked=await updater.download(update.info,place,p=>{update.progress=p;broadcast();});
    if(active())throw new Error(tr('error.planStartedDuringDownload'));
    update.phase='installing';broadcast();
    activity('update-install',{from:VERSION,to:update.info.latest});
    try{await updater.install(unpacked,place,activityFile);}
    catch(ex){
      // The hand-over didn't start: stay open, clean up, and offer the manual download instead.
      try{fs.rmSync(unpacked.work,{recursive:true,force:true});}catch{}
      activity('update-handover-failed',{message:ex.message});shell.openExternal(update.info.page);
      throw new Error(tr('error.downloadPageOpened',{error:ex.message}));
    }
    setTimeout(()=>{reset();app.quit();},300);
  }catch(ex){update={...update,phase:'idle',progress:0,error:ex.message};broadcast();throw ex;}
}
function validateUpdate(update){
  const result={};
  for(const key of ['codexEnabled','claudeEnabled','watchWindows','waitForAway','minimizeToTray'])if(typeof update[key]==='boolean')result[key]=update[key];
  for(const key of ['codexSessionsOverride','claudeHomeOverride'])if(typeof update[key]==='string'&&update[key].length<4000)result[key]=update[key];
  if(power.actions.includes(update.action))result.action=update.action;
  if(['Codex','Timer'].includes(update.scheduleMode))result.scheduleMode=update.scheduleMode;
  for(const key of ['quietMinutes','countdownSeconds','timerMinutes','awayMinutes']){const value=Number(update[key]);if(Number.isFinite(value)&&value>=1&&value<=(key==='countdownSeconds'?600:1440))result[key]=value;}
  return result;
}
// ——— Language ———
// Switching applies at once: the window and countdown banners re-render from the broadcast state,
// and the tray tooltip/menu, the macOS menu and later notifications and dialogs use the new strings.
function setLanguage(language){
  settings.language=i18n.setLanguage(language);save();
  if(preview)previewData(previewStarted);
  setApplicationMenu();trayTip='';trayMenuKey='';broadcast();
}
function setApplicationMenu(){
  if(process.platform!=='darwin'){Menu.setApplicationMenu(null);return;}
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    {label:'Quiet AI',submenu:[{role:'about',label:tr('menu.about')},{type:'separator'},{role:'hide',label:tr('menu.hide')},{role:'hideOthers',label:tr('menu.hideOthers')},{role:'unhide',label:tr('menu.showAll')},{type:'separator'},{role:'quit',label:tr('menu.quit')}]},
    {label:tr('menu.edit'),submenu:[{role:'copy',label:tr('menu.copy')},{role:'paste',label:tr('menu.paste')},{role:'selectAll',label:tr('menu.selectAll')}]},
    {label:tr('menu.window'),submenu:[{label:tr('tray.open'),accelerator:'CmdOrCtrl+Shift+O',click:showWindow},{role:'minimize',label:tr('menu.minimize')},{role:'front',label:tr('menu.front')}]}]));
}
function quitDialog(){return{type:'question',buttons:[tr('dialog.keepRunning'),tr('dialog.quitAndCancel')],defaultId:0,cancelId:0,title:'Quiet AI',message:tr('dialog.quitMessage'),detail:tr('dialog.quitDetail')};}
// Illustrative sessions for --preview screenshots, in the chosen language. Never a power plan.
let previewStarted=0;
function previewData(now){
  previewStarted=now;
  const folder=tr('preview.folder');
  sources={codex:{detected:true,folder,origin:'User profile'},claude:{detected:true,folder,origin:'User profile'}};
  snapshot={chatCount:3,backgroundRunning:1,scheduled:0,uncertain:0,clear:false,checkedUtc:new Date().toISOString(),chats:[{provider:'Codex',title:tr('preview.chat1'),session:'demo-1',startedUtc:new Date(now-23*60000).toISOString()},{provider:'Codex',title:tr('preview.chat2'),session:'demo-2',startedUtc:new Date(now-7*60000).toISOString()},{provider:'Claude',title:tr('preview.chat3'),session:'demo-3',startedUtc:new Date(now-64*60000).toISOString()}],codex:{enabled:true,connected:true,chatCount:2,detail:'Local sessions connected.'},claude:{enabled:true,connected:true,chatCount:1,detail:'Lifecycle hooks connected.'},work:[]};
}
ipcMain.handle('quiet:command',async(event,command,payload={})=>{
  if(event.sender!==window.webContents){
    // The countdown banners may only read the state and cancel.
    if(!overlays.some(o=>!o.isDestroyed()&&o.webContents===event.sender))throw new Error('Unknown window.');
    if(command==='state')return state();
    if(command==='stop'){reset();message=tr('msg.countdownCancelled');broadcast();return state();}
    throw new Error('Not allowed.');
  }
  if(command==='state')return state();
  if(command==='stop'){reset();message=tr('msg.planStopped');broadcast();return state();}
  if(command==='minimize'){if(settings.minimizeToTray)hideToTray();else window.minimize();return;}
  if(command==='close'){window.close();return;}
  if(command==='maximize'){window.isMaximized()?window.unmaximize():window.maximize();return;}
  if(command==='website'){shell.openExternal(WEBSITE);return state();}
  if(command==='diagnostics'){clipboard.writeText(JSON.stringify({version:VERSION,platform:process.platform,language:settings.language,phase:plan.phase,icons:iconReport,windows:{fresh:windowsFresh(),claude:windows.claude,codex:windows.codex,error:windows.error},retiredCodexTurns:Object.values(staleReasons).reduce((a,r)=>(a[r]=(a[r]||0)+1,a),{}),claudeCheck:claudeCheck&&{found:claudeCheck.found,events:claudeCheck.events,disabled:claudeCheck.disabled,ran:claudeCheck.ran,ok:claudeCheck.ok,exitCode:claudeCheck.exitCode},providers:snapshot?{codex:{enabled:snapshot.codex.enabled,connected:snapshot.codex.connected,chats:snapshot.codex.chatCount},claude:{enabled:snapshot.claude.enabled,connected:snapshot.claude.connected,chats:snapshot.claude.chatCount}}:null},null,2));message=tr('msg.summaryCopied');broadcast();return state();}
  if(command==='chatMenu'){chatMenu(payload);return state();}
  if(command==='restoreDismissed'){restoreDismissed();return state();}
  if(manualReview&&!['theme','language','tray','releasePage'].includes(command))throw new Error(tr('error.finishReview'));
  if(command==='theme'){if(THEMES.includes(payload.theme)){settings.theme=payload.theme;nativeTheme.themeSource=settings.theme;save();}broadcast();return state();}
  if(command==='language'){if(i18n.LANGUAGES.includes(payload.language))setLanguage(payload.language);return state();} // allowed while armed
  if(command==='checkUpdate'){await checkUpdate(true);return state();}
  if(command==='installUpdate'){await installUpdate();return state();}
  if(command==='releasePage'){shell.openExternal(update.info?.page||'https://github.com/'+updater.REPO+'/releases');return state();}
  if(command==='tray'){settings.minimizeToTray=payload.on===true;save();broadcast();return state();} // allowed while armed
  if(active())throw new Error(tr('error.stopBeforeChange'));
  if(command==='update'){Object.assign(settings,validateUpdate(payload));sources=discover(settings);save();await scan();return state();}
  if(command==='discover'){sources=discover(settings);if(!settings.codexSessionsOverride)settings.codexEnabled=sources.codex.detected;if(!settings.claudeHomeOverride)settings.claudeEnabled=sources.claude.detected;save();message=tr('msg.discovery');await scan();return state();}
  if(command==='browse'){
    if(!['codex','claude'].includes(payload.provider))throw new Error('Unknown provider.');
    const selection=await dialog.showOpenDialog(window,{title:tr(payload.provider==='codex'?'dialog.browseCodex':'dialog.browseClaude'),properties:['openDirectory']});
    if(!selection.canceled){settings[payload.provider==='codex'?'codexSessionsOverride':'claudeHomeOverride']=selection.filePaths[0];settings[payload.provider+'Enabled']=true;sources=discover(settings);save();await scan();}return state();
  }
  if(command==='checkClaude'){
    if(operation)throw new Error(tr('error.alreadyWorking'));
    operation='check';broadcast();
    try{claudeCheck=await checkClaude();claudeCheck.at=Date.now();}
    finally{operation=null;}
    message=claudeCheck.ok?tr('msg.hookWorks'):'';
    error=claudeCheck.ok?'':tr('error.claudeConnection',{problem:tr(claudeCheck.problemKey,claudeCheck.problemParams)});
    broadcast();return state();
  }
  if(command==='install'||command==='remove'){
    if(operation)throw new Error(tr('error.alreadyWorking'));
    operation=command;error='';message='';broadcast();
    try{
      await waitForScan();
      busy=true;
      const result=await agent.request(command,options());
      settings.claudeEnabled=command==='install';save();
      message=tr(command==='install'?'msg.claudeConnected':'msg.claudeRemoved');
    }catch(ex){error=tr(command==='install'?'error.connectFailed':'error.disconnectFailed',{error:i18n.monitorText(ex.message)});throw new Error(error);}
    finally{busy=false;operation=null;broadcast();}
    await scan();return state();
  }
  if(command==='arm'){
    if(preview)throw new Error(tr('error.previewNoPower'));
    if(settings.scheduleMode==='Codex'&&!settings.codexEnabled&&!settings.claudeEnabled)throw new Error(tr('error.enableProvider'));
    error='';message='';lastRevision=null;
    plan=settings.scheduleMode==='Timer'?{phase:'timer',started:Date.now(),until:Date.now()+settings.timerMinutes*60000}:{phase:'waiting',started:null,until:null};
    if(settings.scheduleMode==='Codex')await scan();broadcast();return state();
  }
  throw new Error('Unknown command.');
});
app.on('second-instance',showWindow);
app.on('activate',showWindow); // Dock activation must restore a window hidden in the menu bar.
app.whenReady().then(()=>{
  if(!primaryInstance)return;
  loadSettings();
  if(preview){settings.codexEnabled=settings.claudeEnabled=true;previewData(Date.now());}
  const executable=path.join(__dirname,'agent',process.platform==='win32'?'QuietAI.Agent.exe':'QuietAI.Agent');
  agent=new Agent(executable,stateRoot);
  setApplicationMenu();
  window=new BrowserWindow({title:'Quiet AI',width:460,height:690,minWidth:420,minHeight:640,maximizable:false,fullscreenable:false,show:false,backgroundColor:themeBackground(),frame:process.platform==='darwin',titleBarStyle:process.platform==='darwin'?'hiddenInset':undefined,trafficLightPosition:{x:16,y:15},icon:path.join(__dirname,'icon.png'),webPreferences:{preload:path.join(__dirname,'preload.js'),nodeIntegration:false,contextIsolation:true,sandbox:true}});
  nativeTheme.on('updated',()=>{if(window&&!window.isDestroyed())window.setBackgroundColor(themeBackground());broadcast();});
  window.webContents.setWindowOpenHandler(()=>({action:'deny'}));
  window.webContents.on('will-navigate',event=>event.preventDefault());
  window.loadFile(path.join(__dirname,'index.html'));
  window.once('ready-to-show',()=>{if(!process.argv.includes('--capture'))window.show();});
  window.webContents.once('did-finish-load',async()=>{
    if(!process.argv.includes('--capture'))window.show();
    broadcast();await scan();
    const index=process.argv.indexOf('--capture');
    if(index>=0){setTimeout(async()=>{const image=await window.webContents.capturePage();fs.writeFileSync(process.argv[index+1],image.toPNG());app.quit();},Number(process.env.QUIETAI_CAPTURE_DELAY)||1800);} // delay: let the theme fade in for screenshots
  });
  window.on('minimize',()=>{if(settings.minimizeToTray&&tray)setImmediate(hideToTray);}); // taskbar / Win+Down minimize
  window.on('close',event=>{
    if(!quitting&&process.platform==='darwin'&&settings.minimizeToTray&&tray&&!process.argv.includes('--capture')){event.preventDefault();hideToTray();return;}
    if(!quitting&&active()&&plan.phase!=='executing'&&!process.argv.includes('--capture')){
      showWindow();
      const choice=dialog.showMessageBoxSync(window,quitDialog());
      if(choice===0){event.preventDefault();return;}
    }
    reset();
  });
  window.webContents.on('render-process-gone',()=>{reset();error=tr('error.interfaceStopped');});
  window.on('unresponsive',()=>{reset();error=tr('error.interfaceUnresponsive');});
  for(const e of ['suspend','resume','lock-screen','unlock-screen','shutdown'])powerMonitor.on(e,()=>activity('power',{what:e,phase:plan.phase}));
  activity('start',{version:VERSION,phase:plan.phase});
  if(!preview)findProviderIcons(); // preview (screenshots) keeps neutral tiles: no third-party logos
  if(!preview)createTray();
  startWindowWatcher();
  setInterval(scan,2000);setInterval(tick,300);
  if(!process.argv.includes('--capture')&&!process.env.QUIETAI_TEST_HOOKS){setTimeout(()=>{if(update.phase==='idle')updater.cleanup();/* never remove the folder of an update already downloading */checkUpdate(false);},15000);setInterval(()=>checkUpdate(false),6*3600000);}
});
app.on('window-all-closed',()=>app.quit());
app.on('will-quit',()=>{try{tray?.destroy();}catch{}tray=null;});
app.on('before-quit',event=>{
  if(active()&&plan.phase!=='executing'&&!process.argv.includes('--capture')&&window&&!window.isDestroyed()){
    showWindow();
    const choice=dialog.showMessageBoxSync(window,quitDialog());
    if(choice===0){event.preventDefault();return;}
  }
  quitting=true;reset();syncBlocker();agent?.close();try{windowWatcher?.kill();}catch{}
});

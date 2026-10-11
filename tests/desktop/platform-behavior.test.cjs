'use strict';
// No GUI or real power calls: execute the actual main-process logic with small
// Electron doubles. Native UI and record-only native countdown checks are separate.
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),vm=require('node:vm');
const {EventEmitter}=require('node:events');
const source=path.resolve(__dirname,'../../desktop');
function fixture(platform='darwin'){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'quietai-platform-unit-'));
  let ready,clock=1000000,idle=7200,quitAnswer=0,afterScan=null;
  const performed=[],blocks=new Set(),notifications=[];
  const app=new EventEmitter();Object.assign(app,{setPath(){},setName(){},setAppUserModelId(){},getPath:()=>root,requestSingleInstanceLock:()=>true,whenReady:()=>({then:fn=>{ready=fn;}}),quit(){const event={preventDefault(){this.prevented=true;}};app.emit('before-quit',event);return event;}});
  class Window extends EventEmitter{
    constructor(options){super();this.options=options;this.visible=true;this.minimized=false;this.destroyed=false;this.webContents=new EventEmitter();Object.assign(this.webContents,{setWindowOpenHandler(){},send(){},once:()=>{}});}
    isDestroyed(){return this.destroyed;}destroy(){this.destroyed=true;this.emit('closed');}isMinimized(){return this.minimized;}restore(){this.minimized=false;}show(){this.visible=true;}hide(){this.visible=false;}focus(){}minimize(){this.minimized=true;this.emit('minimize');}isVisible(){return this.visible;}loadFile(){}setAlwaysOnTop(){}flashFrame(){}setBackgroundColor(){}setVisibleOnAllWorkspaces(_visible,options){this.workspaceOptions=options;}showInactive(){}moveTop(){}
  }
  class Tray extends EventEmitter{constructor(){super();this.attached=null;this.popup=null;}setToolTip(tip){this.tip=tip;}setContextMenu(menu){this.attached=menu;}popUpContextMenu(menu){this.popup=menu;}destroy(){}}
  const image={isEmpty:()=>false,resize(){return this;},toDataURL:()=>'',toBitmap:()=>Buffer.alloc(4),setTemplateImage(value){this.template=value;}};
  const nativeTheme=new EventEmitter();Object.assign(nativeTheme,{shouldUseDarkColors:true});
  const powerMonitor=new EventEmitter();powerMonitor.getSystemIdleTime=()=>{if(idle instanceof Error)throw idle;return idle;};
  class Notification extends EventEmitter{static isSupported(){return true;}constructor(options){super();this.options=options;this.closed=false;notifications.push(this);}show(){this.emit('show');}close(){this.closed=true;}}
  const quiet=()=>{const p={enabled:true,connected:true,clear:true,chatCount:0,work:[],chats:[],detail:'Connected'};return{codex:{...p},claude:{...p},work:[],chats:[],chatCount:0,clear:true,checkedUtc:new Date(clock).toISOString()};};
  class Agent{async request(){if(afterScan)afterScan();return{snapshot:quiet()};}close(){}}
  const electron={app,BrowserWindow:Window,Tray,nativeTheme,powerMonitor,nativeImage:{createFromPath:()=>image,createFromDataURL:()=>image},Menu:{buildFromTemplate:items=>({items}),setApplicationMenu(){}},ipcMain:{handle(){}},dialog:{showMessageBoxSync:()=>quitAnswer},Notification,powerSaveBlocker:{start(){const id=blocks.size+1;blocks.add(id);return id;},stop:id=>blocks.delete(id)},shell:{beep(){}},clipboard:{},screen:{getAllDisplays:()=>[{workArea:{x:0,y:0,width:1920,height:1080}}]}};
  const processDouble={platform,argv:['unit-test'],env:{QUIETAI_PROFILE:root,LOCALAPPDATA:root,QUIETAI_TEST_HOOKS:'1'}};
  const context=vm.createContext({Buffer,console,performance,process:processDouble,__dirname:source,setInterval(){},setTimeout(){},setImmediate,Date:class extends Date{static now(){return clock;}},require(name){if(name==='electron')return electron;if(name==='node:child_process')return{execFile(){},spawn(){throw new Error('No subprocesses in unit fixtures');}};if(name==='./agent')return Agent;if(name==='./discovery')return{discover:()=>({codex:{detected:true,folder:root},claude:{detected:true,folder:root}})};if(name==='./power')return{actions:['Sleep','Shutdown','Restart','Display'],names:{Sleep:'Sleep'},perform:async action=>performed.push(action)};if(name==='./updater')return{REPO:''};if(name==='./mac-icons')return{bundles:()=>new Promise(()=>{}),icon:async()=>null};if(name==='./package.json')return{version:'4.2.2'};return require(name);}});
  vm.runInContext('globalThis.global=globalThis;',context);
  vm.runInContext(fs.readFileSync(path.join(source,'main.js'),'utf8'),context,{filename:'main.js'});
  const evaluate=code=>vm.runInContext(code,context);
  ready();
  evaluate('settings.waitForAway=true; settings.awayMinutes=10; snapshot={clear:true,checkedUtc:new Date(Date.now()).toISOString()};');
  return{evaluate,app,performed,blocks,notifications,idle(value){idle=value;},quitAnswer(value){quitAnswer=value;},afterScan(fn){afterScan=fn;},cleanup(){fs.rmSync(root,{recursive:true,force:true});}};
}

test('mac tray builds current menu on each click and Stop cancels safely',()=>{
  const f=fixture();try{
    f.evaluate("tray.emit('click');");assert.equal(f.evaluate('tray.popup.items.find(x=>x.label===\'Stop plan\').enabled'),false);
    f.evaluate("plan={phase:'waiting'};tray.emit('click');");assert.equal(f.evaluate('tray.popup.items.find(x=>x.label===\'Stop plan\').enabled'),true);
    f.evaluate("tray.popup.items.find(x=>x.label==='Stop plan').click();");assert.equal(f.evaluate('plan.phase'),'disarmed');assert.equal(f.performed.length,0);
    f.evaluate("plan={phase:'countdown',until:Date.now()+30000};tray.emit('click');");assert.equal(f.evaluate("tray.popup.items.find(x=>x.label==='Cancel countdown').enabled"),true);
    f.evaluate("tray.popup.items.find(x=>x.label==='Cancel countdown').click();");assert.equal(f.evaluate('plan.phase'),'disarmed');assert.equal(f.performed.length,0);
  }finally{f.cleanup();}
});
test('Mac close hides; Dock activation restores; explicit Quit exits',()=>{
  const f=fixture();try{
    f.evaluate("globalThis.closeEvent={preventDefault(){this.prevented=true;}};window.emit('close',closeEvent);");assert.equal(f.evaluate('closeEvent.prevented'),true);assert.equal(f.evaluate('window.isVisible()'),false);
    f.app.emit('activate');assert.equal(f.evaluate('window.isVisible()'),true);
    f.app.quit();assert.equal(f.evaluate('quitting'),true);
  }finally{f.cleanup();}
});
test('armed Cmd-Q and tray Quit share confirmation; Keep preserves plan',()=>{
  const f=fixture();try{
    f.evaluate("plan={phase:'waiting'};");assert.equal(f.app.quit().prevented,true);assert.equal(f.evaluate('plan.phase'),'waiting');assert.equal(f.evaluate('quitting'),false);
    f.quitAnswer(1);f.app.quit();assert.equal(f.evaluate('plan.phase'),'disarmed');assert.equal(f.evaluate('quitting'),true);assert.equal(f.performed.length,0);
  }finally{f.cleanup();}
});
test('Windows close still closes rather than hiding',()=>{
  const f=fixture('win32');try{f.evaluate("globalThis.closeEvent={preventDefault(){this.prevented=true;}};window.emit('close',closeEvent);");assert.equal(f.evaluate('!!closeEvent.prevented'),false);}finally{f.cleanup();}
});
for(const [name,value] of [['exception',new Error('idle unavailable')],['NaN',NaN],['Infinity',Infinity],['negative',-1],['undefined',undefined]]){
  test(`idle ${name} prevents countdown and power in every waiting phase`,async()=>{
    const f=fixture();try{
      f.idle(value);
      for(const phase of ['timer','idle','countdown']){
        f.evaluate(`plan={phase:'${phase}',started:Date.now()-5000,until:Date.now()-1,timer:true};`);
        await f.evaluate('tick()');assert.notEqual(f.evaluate('plan.phase'),'countdown');assert.equal(f.performed.length,0);
      }
    }finally{f.cleanup();}
  });
}
test('idle failure after final provider scan also prevents power',async()=>{
  const f=fixture();try{
    f.afterScan(()=>f.idle(NaN));f.evaluate("plan={phase:'countdown',started:Date.now()-5000,until:Date.now()-1,timer:false};");
    await f.evaluate('tick()');assert.notEqual(f.evaluate('plan.phase'),'completed');assert.equal(f.performed.length,0);
  }finally{f.cleanup();}
});
test('valid idle can reach only the record-only power double',async()=>{
  const f=fixture();try{
    f.evaluate("plan={phase:'countdown',started:Date.now()-5000,until:Date.now()-1,timer:true};");await f.evaluate('tick()');assert.deepEqual(f.performed,['Sleep']);
  }finally{f.cleanup();}
});
test('native minimize event hides with menu-bar preference and restores',async()=>{
  const f=fixture();try{
    f.evaluate('window.minimize();');await new Promise(setImmediate);assert.equal(f.evaluate('window.isVisible()'),false);
    f.app.emit('activate');assert.equal(f.evaluate('window.isVisible()'),true);assert.equal(f.evaluate('window.isMinimized()'),false);
    f.evaluate('settings.minimizeToTray=false;window.minimize();');await new Promise(setImmediate);assert.equal(f.evaluate('window.isVisible()'),true);assert.equal(f.evaluate('window.isMinimized()'),true);
  }finally{f.cleanup();}
});
test('timer notification click cancels with away safety disabled and dismisses banner',()=>{
  const f=fixture();try{
    f.evaluate("settings.waitForAway=false;plan={phase:'countdown',timer:true,started:Date.now(),until:Date.now()+30000};announceCountdown();broadcast();");
    const note=f.notifications.at(-1);assert.match(note.options.body,/timer has finished/);assert.match(note.options.body,/Click this notification to cancel/);
    assert.equal(f.evaluate('overlays.length'),1);assert.equal(f.evaluate('overlays[0].workspaceOptions.visibleOnFullScreen'),true);
    assert.equal(f.evaluate('overlays[0].options.focusable'),false);assert.equal(f.blocks.size,1);
    note.emit('click');assert.equal(f.evaluate('plan.phase'),'disarmed');assert.equal(f.evaluate('overlays.length'),0);assert.equal(f.blocks.size,0);assert.equal(note.closed,true);assert.equal(f.performed.length,0);
  }finally{f.cleanup();}
});
test('new work during countdown dismisses stale notification and overlays',async()=>{
  const f=fixture();try{
    f.evaluate("plan={phase:'countdown',timer:false,started:Date.now(),until:Date.now()+30000};lastRevision='old';announceCountdown();broadcast();");
    const note=f.notifications.at(-1);await f.evaluate('scan()');assert.notEqual(f.evaluate('plan.phase'),'countdown');assert.equal(note.closed,true);assert.equal(f.evaluate('overlays.length'),0);assert.equal(f.performed.length,0);
  }finally{f.cleanup();}
});
test('renderer failure cancels record-only plan and releases keep-awake on broadcast',()=>{
  const f=fixture();try{
    f.evaluate("plan={phase:'countdown',timer:true,started:Date.now(),until:Date.now()+30000};announceCountdown();broadcast();window.webContents.emit('render-process-gone');broadcast();");
    assert.equal(f.evaluate('plan.phase'),'disarmed');assert.equal(f.blocks.size,0);assert.equal(f.evaluate('overlays.length'),0);assert.equal(f.performed.length,0);
  }finally{f.cleanup();}
});

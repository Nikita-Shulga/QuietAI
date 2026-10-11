'use strict';
// No GUI or real power calls: execute the actual main-process logic with small
// Electron doubles. Native UI and record-only native countdown checks are separate.
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),vm=require('node:vm');
const {EventEmitter}=require('node:events');
const source=path.resolve(__dirname,'../../desktop');
function fixture(platform='darwin'){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'quietai-platform-unit-'));
  let ready,clock=1000000,idle=7200,quitAnswer=0,afterScan=null,scanValue=null,dialogAnswer=0,dialogAcknowledged=false,dialogHook=null,powerHook=null,ipc;
  const dialogs=[],menus=[];
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
  class Agent{async request(){if(afterScan)await afterScan();if(scanValue instanceof Error)throw scanValue;const s=scanValue?structuredClone(scanValue):quiet();s.checkedUtc=new Date(clock).toISOString();return{snapshot:s};}close(){}}
  const electron={app,BrowserWindow:Window,Tray,nativeTheme,powerMonitor,nativeImage:{createFromPath:()=>image,createFromDataURL:()=>image},Menu:{buildFromTemplate:items=>({items,popup(){menus.push(this);}}),setApplicationMenu(){}},ipcMain:{handle(_name,fn){ipc=fn;}},dialog:{showMessageBoxSync:()=>quitAnswer,async showMessageBox(_window,options){dialogs.push(options);if(dialogHook)await dialogHook();return{response:dialogAnswer,checkboxChecked:dialogAcknowledged};}},Notification,powerSaveBlocker:{start(){const id=blocks.size+1;blocks.add(id);return id;},stop:id=>blocks.delete(id)},shell:{beep(){}},clipboard:{},screen:{getAllDisplays:()=>[{workArea:{x:0,y:0,width:1920,height:1080}}]}};
  const processDouble={platform,argv:['unit-test'],env:{QUIETAI_PROFILE:root,LOCALAPPDATA:root,QUIETAI_TEST_HOOKS:'1'}};
  const context=vm.createContext({Buffer,console,performance,process:processDouble,__dirname:source,setInterval(){},setTimeout(){},setImmediate,Date:class extends Date{static now(){return clock;}},require(name){if(name==='electron')return electron;if(name==='node:child_process')return{execFile(){},spawn(){throw new Error('No subprocesses in unit fixtures');}};if(name==='./dismissed-work')return require(path.join(source,'dismissed-work'));if(name==='./agent')return Agent;if(name==='./discovery')return{discover:()=>({codex:{detected:true,folder:root},claude:{detected:true,folder:root}})};if(name==='./power')return{actions:['Sleep','Shutdown','Restart','Display'],names:{Sleep:'Sleep'},perform:async action=>{performed.push(action);if(powerHook)await powerHook();}};if(name==='./updater')return{REPO:''};if(name==='./mac-icons')return{bundles:()=>new Promise(()=>{}),icon:async()=>null};if(name==='./package.json')return require(path.join(source,'package.json'));return require(name);}});
  vm.runInContext('globalThis.global=globalThis;',context);
  vm.runInContext(fs.readFileSync(path.join(source,'main.js'),'utf8'),context,{filename:'main.js'});
  const evaluate=code=>vm.runInContext(code,context);
  ready();
  evaluate('settings.waitForAway=true; settings.awayMinutes=10; snapshot={clear:true,checkedUtc:new Date(Date.now()).toISOString()};');
  return{evaluate,app,performed,blocks,notifications,dialogs,menus,command:(name,payload)=>ipc({sender:evaluate('window.webContents')},name,payload),scanValue(value){scanValue=value;},dialogAnswer(value){dialogAnswer=value;},dialogAcknowledged(value){dialogAcknowledged=value;},dialogHook(fn){dialogHook=fn;},powerHook(fn){powerHook=fn;},idle(value){idle=value;},quitAnswer(value){quitAnswer=value;},afterScan(fn){afterScan=fn;},cleanup(){fs.rmSync(root,{recursive:true,force:true});}};
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

const {snapshot:rootSnapshot,item:rootItem}=require('./dismissal-fixtures.cjs');
function deferred(){let resolve;const promise=new Promise(r=>resolve=r);return{promise,resolve};}
async function runningFixture(platform){const f=fixture(platform);f.scanValue(rootSnapshot());await f.evaluate('scan()');return f;}
for(const platform of ['darwin','win32']){
  test(platform+' native menu confirms only current observed prompts; Restore restores blockers',async()=>{
    const f=await runningFixture(platform);try{
      const token=f.evaluate('snapshot.chats[0].dismissToken');
      await f.command('chatMenu',{provider:'Codex',session:'one',token});assert.equal(f.menus.at(-1).items[0].enabled,true);
      f.dialogAnswer(1);f.dialogAcknowledged(true);await f.evaluate(`dismissChat('Codex','one','${token}')`);
      assert.equal(f.dialogs[0].defaultId,0);assert.equal(f.dialogs[0].cancelId,0);assert.equal(f.dialogs[0].checkboxChecked,false);assert.match(f.dialogs[0].checkboxLabel,/power plan/);assert.match(f.dialogs[0].detail,/no longer block/);assert.match(f.dialogs[0].detail,/does not stop the agent/);
      assert.equal(f.evaluate('dismissedWork.count'),1);assert.equal(f.evaluate('snapshot.clear'),true);assert.equal(f.evaluate('rawSnapshot.work.length'),1);
      await f.command('restoreDismissed');assert.equal(f.evaluate('snapshot.clear'),false);assert.equal(f.evaluate('dismissedWork.count'),0);assert.equal(f.performed.length,0);
    }finally{f.cleanup();}
  });
  test(platform+' Cancel and unknown/direct IPC cannot bypass warning',async()=>{
    const f=await runningFixture(platform);try{const token=f.evaluate('snapshot.chats[0].dismissToken');
      await f.evaluate(`dismissChat('Codex','one','${token}')`);assert.equal(f.evaluate('dismissedWork.count'),0);
      await assert.rejects(f.command('dismissChat',{provider:'Codex',session:'one',token}),/Unknown command/);
      await f.command('chatMenu',{provider:'Codex',session:'one',token:'forged'});assert.equal(f.menus.at(-1).items[0].enabled,false);assert.equal(f.performed.length,0);
    }finally{f.cleanup();}
  });
  test(platform+' new same-key activity while warning is open rejects stale confirmation',async()=>{
    const f=await runningFixture(platform);try{const token=f.evaluate('snapshot.chats[0].dismissToken');f.dialogAnswer(1);f.dialogAcknowledged(true);f.dialogHook(()=>f.scanValue(rootSnapshot([rootItem('Codex','one',undefined,{activityToken:'new generation'})])));
      await assert.rejects(f.evaluate(`dismissChat('Codex','one','${token}')`),/changed/);assert.equal(f.evaluate('dismissedWork.count'),0);assert.equal(f.evaluate('snapshot.clear'),false);assert.equal(f.performed.length,0);
    }finally{f.cleanup();}
  });
  test(platform+' review pauses countdown, blocks concurrent commands and Stop remains stopped',async()=>{
    const f=await runningFixture(platform);try{const token=f.evaluate('snapshot.chats[0].dismissToken'),gate=deferred(),shown=deferred();f.dialogAnswer(1);f.dialogAcknowledged(true);f.dialogHook(()=>{shown.resolve();return gate.promise;});
      f.evaluate("settings.waitForAway=false;plan={phase:'countdown',timer:false,until:Date.now()-1,started:Date.now()-1000};");
      const review=f.evaluate(`dismissChat('Codex','one','${token}')`);await shown.promise;await f.evaluate('tick()');assert.equal(f.performed.length,0);
      await assert.rejects(f.command('arm'),/Finish reviewing/);await assert.rejects(f.evaluate(`dismissChat('Codex','one','${token}')`),/cannot be reviewed/);await f.command('stop');gate.resolve();await review;
      assert.equal(f.evaluate('plan.phase'),'disarmed');assert.equal(f.performed.length,0);
    }finally{f.cleanup();}
  });
}
test('scan failure fails closed; final timer countdown is cancelled even on Cancel',async()=>{
 const f=await runningFixture('darwin');try{const token=f.evaluate('snapshot.chats[0].dismissToken');f.scanValue(new Error('read failed'));await assert.rejects(f.evaluate(`dismissChat('Codex','one','${token}')`),/could not be verified/);assert.equal(f.evaluate('dismissedWork.count'),0);
 f.scanValue(rootSnapshot());await f.evaluate('scan()');f.evaluate("plan={phase:'countdown',timer:true,until:Date.now()-1,started:Date.now()-1000};");await f.evaluate(`dismissChat('Codex','one','${token}')`);assert.equal(f.evaluate('plan.phase'),'disarmed');assert.equal(f.performed.length,0);
 }finally{f.cleanup();}
});
test('a tick awaiting its final scan cannot act after a manual review starts',async()=>{
 const f=await runningFixture('darwin');try{const token=f.evaluate('snapshot.chats[0].dismissToken'),gate=deferred(),scanning=deferred();f.afterScan(()=>{scanning.resolve();return gate.promise;});f.evaluate("settings.waitForAway=false;plan={phase:'countdown',timer:false,until:Date.now()-1,started:Date.now()-1000};");
 const tick=f.evaluate('tick()');await scanning.promise;f.evaluate('manualReview=true;restartManualWait();');gate.resolve();await tick;assert.equal(f.performed.length,0);assert.equal(f.evaluate('plan.phase'),'waiting');
 }finally{f.cleanup();}
});

test('timer action already awaiting OS completion refuses dismissal and restore',async()=>{const f=await runningFixture('darwin');try{const token=f.evaluate('snapshot.chats[0].dismissToken'),gate=deferred(),started=deferred();f.powerHook(()=>{started.resolve();return gate.promise;});f.evaluate("settings.waitForAway=false;plan={phase:'countdown',timer:true,until:Date.now()-1,started:Date.now()-1000};");const tick=f.evaluate('tick()');await started.promise;await assert.rejects(f.evaluate(`dismissChat('Codex','one','${token}')`),/cannot be reviewed/);assert.throws(()=>f.evaluate('restoreDismissed()'),/Wait until/);assert.equal(f.dialogs.length,0);assert.equal(f.evaluate('dismissedWork.count'),0);gate.resolve();await tick;assert.deepEqual(f.performed,['Sleep']);}finally{f.cleanup();}});
test('tracker invalidity clears override and returns the raw blocking record',async()=>{const f=await runningFixture('darwin');try{const token=f.evaluate('snapshot.chats[0].dismissToken');f.dialogAnswer(1);f.dialogAcknowledged(true);await f.evaluate(`dismissChat('Codex','one','${token}')`);const bad=rootSnapshot();delete bad.codex.running;f.scanValue(bad);await f.evaluate('scan()');assert.equal(f.evaluate('dismissedWork.count'),0);assert.equal(f.evaluate('snapshot.clear'),false);assert.equal(f.evaluate('snapshot.work.length'),1);assert.equal(f.performed.length,0);}finally{f.cleanup();}});

for(const platform of ['darwin','win32'])for(const ack of [false,undefined,null,'true',1])test(platform+' native Return/Dismiss response without explicit true acknowledgment cannot exclude work: '+String(ack),async()=>{const f=await runningFixture(platform);try{const token=f.evaluate('snapshot.chats[0].dismissToken');f.dialogAnswer(1);f.dialogAcknowledged(ack);await f.evaluate(`dismissChat('Codex','one','${token}')`);assert.equal(f.evaluate('dismissedWork.count'),0);assert.equal(f.evaluate('snapshot.clear'),false);assert.equal(f.evaluate('snapshot.chatCount'),1);assert.match(f.evaluate('message'),/Nothing was dismissed/);assert.equal(f.performed.length,0);}finally{f.cleanup();}});
for(const platform of ['darwin','win32'])test(platform+' Cancel still cancels after checkbox was explicitly checked',async()=>{const f=await runningFixture(platform);try{const token=f.evaluate('snapshot.chats[0].dismissToken');f.dialogAnswer(0);f.dialogAcknowledged(true);await f.evaluate(`dismissChat('Codex','one','${token}')`);assert.equal(f.evaluate('dismissedWork.count'),0);assert.equal(f.evaluate('snapshot.clear'),false);assert.equal(f.performed.length,0);}finally{f.cleanup();}});

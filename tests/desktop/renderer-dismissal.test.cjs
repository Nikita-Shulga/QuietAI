'use strict';
// Optional DOM contract tests. jsdom is a QA-only dependency, never packaged.
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
let JSDOM;try{({JSDOM}=require('jsdom'));}catch{}
const {item,snapshot}=require('./dismissal-fixtures.cjs'),{DismissedWork}=require('../../desktop/dismissed-work');
function fixture(platform){
 const source=path.resolve(__dirname,'../../desktop'),dom=new JSDOM(fs.readFileSync(path.join(source,'index.html'),'utf8'),{runScripts:'outside-only',pretendToBeVisual:true,url:'https://quietai.invalid/'}),w=dom.window,commands=[];let listener;
 const st={platform,version:JSON.parse(fs.readFileSync(path.join(source,'package.json'),'utf8')).version,dark:true,settings:{codexEnabled:true,claudeEnabled:true,watchWindows:false,waitForAway:true,minimizeToTray:true,scheduleMode:'Codex',action:'Sleep',quietMinutes:5,countdownSeconds:60,timerMinutes:60,awayMinutes:10,theme:'system',codexSessionsOverride:'',claudeHomeOverride:''},sources:{codex:{exists:true,detected:true,folder:'/fixture/codex',origin:'fixture'},claude:{exists:true,detected:true,folder:'/fixture/claude',origin:'fixture'}},snapshot:new DismissedWork().apply(snapshot()),plan:{phase:'disarmed'},actions:['Sleep'],actionNames:{Sleep:'Sleep'},update:{phase:'idle'},icons:{},windows:{supported:platform==='win32'},dismissed:{count:0}};
 w.quiet={subscribe(fn){listener=fn;},async command(name,payload){commands.push({name,payload});return st;}};w.eval(fs.readFileSync(path.join(source,'i18n.js'),'utf8'));w.eval(fs.readFileSync(path.join(source,'renderer.js'),'utf8'));
 return{w,commands,st,render:()=>listener(st),close:()=>w.close()};
}
for(const platform of ['darwin','win32'])test(platform+' right click and accessible native-menu action use latest token', {skip:!JSDOM},async()=>{
 const f=fixture(platform);try{await new Promise(setImmediate);const row=f.w.document.querySelector('#chat-list li'),button=row.querySelector('.chat-actions');assert.equal(button.getAttribute('aria-haspopup'),'menu');assert.match(button.getAttribute('aria-label'),/Actions for/);button.focus();
 const first=f.st.snapshot.chats[0].dismissToken;f.st.snapshot=new DismissedWork().apply(snapshot([item('Codex','one',undefined,{activityToken:'new'})]));f.render();assert.equal(f.w.document.activeElement,button);assert.notEqual(f.st.snapshot.chats[0].dismissToken,first);
 const ev=new f.w.MouseEvent('contextmenu',{bubbles:true,cancelable:true});row.dispatchEvent(ev);assert.equal(ev.defaultPrevented,true);assert.equal(f.commands.at(-1).name,'chatMenu');assert.equal(f.commands.at(-1).payload.token,f.st.snapshot.chats[0].dismissToken);
 for(const key of ['ContextMenu','F10']){const ev=new f.w.KeyboardEvent('keydown',{key,shiftKey:key==='F10',bubbles:true,cancelable:true});button.dispatchEvent(ev);assert.equal(ev.defaultPrevented,true);assert.equal(f.commands.at(-1).name,'chatMenu');}
 button.click();assert.equal(f.commands.at(-1).name,'chatMenu');assert.equal(f.commands.filter(c=>c.name==='arm').length,0);
 }finally{await new Promise(setImmediate);f.close();}
});
test('dismissed count and Restore remain visible and keyboard-focusable',{skip:!JSDOM},async()=>{const f=fixture('darwin');try{await new Promise(setImmediate);f.st.dismissed={count:2};f.render();const bar=f.w.document.getElementById('dismissed-work'),button=f.w.document.getElementById('restore-dismissed');assert.equal(bar.classList.contains('hidden'),false);assert.match(bar.textContent,/2 entries dismissed/);assert.match(bar.textContent,/No longer blocking AI plans/);assert.equal(button.disabled,false);button.focus();assert.equal(f.w.document.activeElement,button);button.click();assert.equal(f.commands.at(-1).name,'restoreDismissed');f.st.dismissed={count:2,reviewing:true};f.render();assert.equal(button.disabled,true);}finally{await new Promise(setImmediate);f.close();}});

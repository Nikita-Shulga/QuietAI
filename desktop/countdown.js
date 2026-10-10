'use strict';
const progressive={Sleep:'Sleeping',Shutdown:'Shutting down',Restart:'Restarting',Hibernate:'Hibernating',Lock:'Locking',Display:'Display off'};
const $=id=>document.getElementById(id);
let state=null;
function clock(sec){sec=Math.max(0,Math.ceil(sec));return Math.floor(sec/60)+':'+String(sec%60).padStart(2,'0');}
function paint(){
  if(!state||state.plan.phase!=='countdown')return;
  const {plan,settings}=state,left=(plan.until-Date.now())/1000,span=(plan.until-plan.started)/1000||1;
  $('what').textContent=progressive[settings.action]||settings.action;
  $('left').textContent=clock(left);
  $('fill').style.transform=`scaleX(${Math.max(0,Math.min(1,left/span))})`;
  $('hint').textContent=(plan.timer?'Your timer is up. ':'Your AI has finished. ')+(settings.waitForAway!==false?'Move the mouse or press Cancel to stay awake.':'Press Cancel to stay awake.');
}
window.quiet.subscribe(s=>{state=s;paint();});
window.quiet.command('state').then(s=>{state=s;paint();});
setInterval(paint,250);
$('cancel').addEventListener('click',()=>window.quiet.command('stop'));
document.addEventListener('keydown',e=>{if(e.key==='Escape')window.quiet.command('stop');});

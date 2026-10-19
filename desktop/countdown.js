'use strict';
const i18n=window.QuietI18n,tr=i18n.tr;
const $=id=>document.getElementById(id);
let state=null;
function clock(sec){sec=Math.max(0,Math.ceil(sec));return Math.floor(sec/60)+':'+String(sec%60).padStart(2,'0');}
function paint(){
  if(!state||state.plan.phase!=='countdown')return;
  const {plan,settings}=state,left=(plan.until-Date.now())/1000,span=(plan.until-plan.started)/1000||1;
  const lang=i18n.setLanguage(settings.language);
  if(document.documentElement.lang!==lang){document.documentElement.lang=lang;$('cancel').textContent=tr('cta.cancel');}
  $('what').textContent=tr('headline.countdown',{action:i18n.has('progressive.'+settings.action)?tr('progressive.'+settings.action):settings.action});
  $('left').textContent=clock(left);
  $('fill').style.transform=`scaleX(${Math.max(0,Math.min(1,left/span))})`;
  $('hint').textContent=tr(plan.timer?'overlay.timerUp':'overlay.aiFinished')+' '+tr(settings.waitForAway!==false?'overlay.moveOrCancel':'overlay.pressCancel');
}
window.quiet.subscribe(s=>{state=s;paint();});
window.quiet.command('state').then(s=>{state=s;paint();});
setInterval(paint,250);
$('cancel').addEventListener('click',()=>window.quiet.command('stop'));
document.addEventListener('keydown',e=>{if(e.key==='Escape')window.quiet.command('stop');});

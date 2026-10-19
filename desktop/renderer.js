'use strict';
const $=id=>document.getElementById(id);
const i18n=window.QuietI18n,tr=i18n.tr; // shared strings (i18n.js, loaded before this script)
const ACTIVE=['waiting','idle','countdown','timer','executing'];
let current=null,dismissed='',openMenu=null,iconKey='';

const icons={
  Sleep:'<path d="M12.6 9.6A5 5 0 0 1 6.4 3.4 5 5 0 1 0 12.6 9.6Z"/>',
  Shutdown:'<path d="M8 2.8v4.6M4.9 4.6a4.6 4.6 0 1 0 6.2 0"/>',
  Restart:'<path d="M12.8 3.6v2.8H10M12.6 6.4A4.7 4.7 0 1 0 12.8 10"/>',
  Hibernate:'<rect x="2.8" y="3.5" width="10.4" height="7.5" rx="1.5"/><path d="M6 13h4"/>',
  Lock:'<rect x="3.8" y="7" width="8.4" height="6.2" rx="1.5"/><path d="M5.8 7V5.4a2.2 2.2 0 0 1 4.4 0V7"/>',
  Display:'<rect x="2.5" y="3" width="11" height="7.6" rx="1.4"/><path d="M6 13h4"/>'
};
const MODES=['Codex','Timer'];
const actionName=a=>tr('action.'+a),progressive=a=>tr('progressive.'+a);
const choices={awayMinutes:[3,5,10,15,30,60],quietMinutes:[1,5,10,15,30,60],timerMinutes:[5,15,30,60,120,240,480],countdownSeconds:[30,60,120]};
const checkSvg='<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3.5 8.4l2.8 2.8 6.2-6.4"/></svg>';

// form: '' (menus), 'Acc' ("in 5 minutes") or 'Gen' ("after 5 minutes"); the same in English.
function duration(key,v,form=''){
  const unit=(name,count)=>tr('dur.'+name+form,{count});
  if(key==='countdownSeconds')return v%60?unit('seconds',v):unit('minutes',v/60);
  if(v<60)return unit('minutes',v);
  const h=v/60;return Number.isInteger(h)?unit('hours',h):unit('minutes',v);
}
function short(key,v){
  if(key==='countdownSeconds')return v%60?v+' sec':v/60+' min';
  if(v<60)return v+' min';const h=v/60;return Number.isInteger(h)?h+' hr':v+' min';
}
async function command(name,payload){try{const s=await window.quiet.command(name,payload);if(s)render(s);}catch(ex){showNotice(cleanError(ex.message),true);}}
function cleanError(m){return String(m||'').replace(/^Error invoking remote method '[^']+': (Error: )?/,'');}
function text(id,v){const n=$(id);if(n.textContent!==v)n.textContent=v;}
let noticeTimer=null,noticeShown='';
function showNotice(v,isError=false){
  const n=$('notice');
  if(!v)return; // an empty state never hides a message the user hasn't had time to read
  if(v===dismissed){n.classList.add('hidden');return;}
  if(v===noticeShown)return; // already shown (or shown and timed out)
  noticeShown=v;n.classList.remove('hidden');n.classList.toggle('error',isError);text('notice-text',v);
  clearTimeout(noticeTimer);noticeTimer=setTimeout(()=>{n.classList.add('hidden');},isError?9000:4500);
}
function plural(key,count){return tr(key,{count});}
function clock(sec){sec=Math.max(0,Math.ceil(sec));const h=Math.floor(sec/3600),m=Math.floor(sec%3600/60),s=sec%60;return h?h+':'+String(m).padStart(2,'0')+':'+String(s).padStart(2,'0'):m+':'+String(s).padStart(2,'0');}
function since(iso){const t=Date.parse(iso);if(!Number.isFinite(t)||t<946684800000)return '';const m=Math.floor((Date.now()-t)/60000);if(m<1)return tr('time.justNow');if(m<60)return tr('time.minutes',{minutes:m});return tr('time.hoursMinutes',{hours:Math.floor(m/60),minutes:m%60});}
// Where a folder was found: environment variable names stay as they are.
function origin(name){return name==='Application support'?tr('origin.appSupport'):name==='Your selected folder'?tr('origin.selected'):name;}
function settingsOpen(){return document.body.classList.contains('settings-open');}
function openSettings(open){closeMenu();document.body.classList.toggle('settings-open',open);$('settings').setAttribute('aria-hidden',String(!open));$('open-settings').classList.toggle('on',open);if(open)requestAnimationFrame(placeThumb);}
function placeThumb(){for(const seg of document.querySelectorAll('.seg')){const b=seg.querySelector('[aria-pressed="true"]'),t=seg.querySelector('.seg-thumb');if(!b||!b.offsetWidth)continue;t.style.width=b.offsetWidth+'px';t.style.transform='translateX('+b.offsetLeft+'px)';}}
window.addEventListener('resize',placeThumb);

// Headline built from [text, class] parts so a time can be highlighted.
function headline(parts){
  const key=JSON.stringify(parts),node=$('headline');
  if(node.dataset.key===key)return;node.dataset.key=key;node.replaceChildren();
  for(const [t,cls] of parts){if(cls){const s=document.createElement('span');s.className=cls;s.textContent=t;node.append(s);}else node.append(t);}
}

// ——— Provider icons: real app icons from this computer, or a quiet monogram ———
function paintIcons(state){
  const key=JSON.stringify([document.documentElement.dataset.mode,state.icons?.codex?1:0,state.icons?.claude?1:0,JSON.stringify(state.icons||{}).length]);
  if(key===iconKey&&!document.querySelector('.picon:empty'))return;iconKey=key;
  for(const node of document.querySelectorAll('.picon[data-provider]'))fillIcon(node,node.dataset.provider);
}
function fillIcon(node,provider){
  const set=current?.icons?.[provider],mode=document.documentElement.dataset.mode==='light'?'light':'dark';
  const src=typeof set==='string'?set:set?.[mode]||set?.dark||set?.light;
  node.replaceChildren();node.classList.toggle('fallback',!src);
  node.classList.toggle('plate',!!(mode==='light'&&set&&set.plateOnLight));
  if(src){const img=document.createElement('img');img.src=src;img.alt='';img.draggable=false;node.append(img);}
  else node.textContent=provider==='codex'?'Cx':'Cl';
  node.title=provider==='codex'?'Codex':'Claude Code';
}

// ——— Language ———
// Static text carries data-i18n (text), data-i18n-label (aria-label) and data-i18n-title (title);
// the English text stays in index.html. Switching re-renders everything without a restart.
let language='';
function applyLanguage(lang){
  lang=i18n.normalize(lang);if(lang===language)return;
  language=i18n.setLanguage(lang);document.documentElement.lang=lang;
  for(const n of document.querySelectorAll('[data-i18n]'))n.textContent=tr(n.dataset.i18n);
  for(const n of document.querySelectorAll('[data-i18n-label]'))n.setAttribute('aria-label',tr(n.dataset.i18nLabel));
  for(const n of document.querySelectorAll('[data-i18n-title]'))n.title=tr(n.dataset.i18nTitle);
  $('observed-work').dataset.empty=tr('holding.empty');
  // Forget what was drawn so every cached part is rebuilt in the new language.
  for(const n of document.querySelectorAll('[data-key]'))n.dataset.key='';
  $('claude-check').dataset.at='';
  requestAnimationFrame(placeThumb);
}

// ——— Signal strip ———
const signal={mode:'loading',amp:0,progress:0,heights:[],canvas:$('signal')};
let palette=null;
function readPalette(){const s=getComputedStyle(document.documentElement),v=n=>s.getPropertyValue(n).trim();palette={ink:v('--sig-ink'),rest:v('--sig-rest'),green:v('--sig-green'),amber:v('--sig-amber')};}

function setSignal(mode,amp=0,progress=0){signal.mode=mode;signal.amp=amp;signal.progress=progress;}
function drawSignal(now){
  const c=signal.canvas,dpr=window.devicePixelRatio||1,w=c.clientWidth,h=c.clientHeight;
  if(w&&h){
    if(c.width!==Math.round(w*dpr)||c.height!==Math.round(h*dpr)){c.width=Math.round(w*dpr);c.height=Math.round(h*dpr);}
    if(!palette)readPalette();
    const x=c.getContext('2d');x.setTransform(dpr,0,0,dpr,0,0);x.clearRect(0,0,w,h);
    const bar=2,step=4,n=Math.floor((w+step-bar)/step),off=Math.round((w-(n*step-(step-bar)))/2),t=now/1000;
    const filled=signal.progress*n;
    for(let i=0;i<n;i++){
      const edge=Math.min(1,Math.min(i+1,n-i)/10);
      const env=Math.pow(Math.sin(Math.PI*(i+.5)/n),.5);
      let target=2,color=palette.rest;
      if(signal.mode==='working'||signal.mode==='loading'){
        const wave=.5+.5*(Math.sin(i*.27+t*1.5)*.5+Math.sin(i*.11-t*.95)*.3+Math.sin(i*.73+t*2.6)*.2);
        target=2+(h-2)*signal.amp*env*wave;
        const lit=.28+.62*wave*env;color=signal.mode==='loading'?palette.rest:`rgba(${palette.ink},${lit.toFixed(3)})`;
      }else if(signal.mode==='progress'||signal.mode==='countdown'||signal.mode==='timer'){
        if(i<filled){
          const ripple=.5+.5*Math.sin(t*2.4-i*.18);
          target=signal.mode==='progress'?h*.22:h*(.3+.18*ripple)*env+4;
          color=signal.mode==='countdown'?`rgba(${palette.amber},${(.75+.25*ripple).toFixed(3)})`:signal.mode==='progress'?palette.green:`rgba(${palette.ink},.9)`;
        }
      }
      const prev=signal.heights[i]??2,cur=prev+(target-prev)*.1;signal.heights[i]=cur;
      x.globalAlpha=edge;x.fillStyle=color;const bh=Math.max(2,cur);
      x.beginPath();x.roundRect(off+i*step,Math.round((h-bh)/2*2)/2,bar,bh,1);x.fill();
    }
    x.globalAlpha=1;
  }
  requestAnimationFrame(drawSignal);
}
requestAnimationFrame(drawSignal);

// ——— Menus ———
function menuItems(name){
  const s=current.settings;
  if(name==='scheduleMode')return MODES.map(v=>({value:v,label:tr('mode.'+v),selected:s.scheduleMode===v}));
  if(name==='action')return current.actions.map(a=>({value:a,label:actionName(a),icon:icons[a],selected:a===s.action}));
  const list=[...choices[name]];if(!list.includes(s[name]))list.push(s[name]);list.sort((a,b)=>a-b);
  return list.map(v=>({value:v,label:duration(name,v),selected:v===s[name]}));
}
function closeMenu(){if(!openMenu)return;openMenu.setAttribute('aria-expanded','false');$('menu').hidden=true;openMenu=null;}
function showMenu(button){
  if(openMenu===button){closeMenu();return;}
  closeMenu();if(!current)return;
  const name=button.dataset.menu,menu=$('menu');menu.replaceChildren();
  for(const item of menuItems(name)){
    const b=document.createElement('button');b.setAttribute('role','menuitemradio');b.setAttribute('aria-checked',String(item.selected));
    b.innerHTML='<span class="check">'+(item.selected?checkSvg:'')+'</span>'+(item.icon?'<span class="micon"><svg viewBox="0 0 16 16" aria-hidden="true">'+item.icon+'</svg></span>':'')+'<span class="label"></span>';
    b.querySelector('.label').textContent=item.label;
    b.addEventListener('click',()=>{closeMenu();command('update',{[name]:item.value});});menu.append(b);
  }
  menu.hidden=false;
  const r=button.getBoundingClientRect(),m=menu.getBoundingClientRect();
  let top=r.bottom+6;if(top+m.height>window.innerHeight-10)top=r.top-m.height-6;
  menu.style.top=Math.max(8,top)+'px';
  menu.style.left=Math.max(8,Math.min(window.innerWidth-m.width-8,r.right-m.width))+'px';
  button.setAttribute('aria-expanded','true');openMenu=button;
  (menu.querySelector('[aria-checked="true"]')||menu.firstChild).focus();
}

// ——— Render ———
function render(state){
  current=state;
  applyLanguage(state.settings?.language);
  const mode=state.dark===false?'light':'dark';
  if(document.documentElement.dataset.mode!==mode){document.documentElement.dataset.mode=mode;palette=null;iconKey='';const l=document.getElementById('chat-list');if(l)l.dataset.key='';}
  const {settings,snapshot,plan}=state;
  const active=ACTIVE.includes(plan.phase),timerMode=settings.scheduleMode==='Timer',action=settings.action;
  document.body.classList.toggle('mac',state.platform==='darwin');
  paintIcons(state);
  const remaining=plan.until?clock((plan.until-Date.now())/1000):'';
  const span=plan.until&&plan.started?plan.until-plan.started:0;
  const done=span?Math.min(1,Math.max(0,(Date.now()-plan.started)/span)):0;
  const count=snapshot?.chatCount||0,background=snapshot?.backgroundRunning||0;
  const uncertain=(snapshot?.uncertain||0)+(state.error&&snapshot?1:0);
  const unconnected=['codex','claude'].filter(n=>settings[n+'Enabled']&&snapshot&&!snapshot[n]?.connected);
  const chats=plural('count.chats',count);
  const amp=Math.min(1,.5+.13*Math.max(count,background?1:0));
  const planLine=timerMode?tr('plan.timerLine',{action:actionName(action),duration:duration('timerMinutes',settings.timerMinutes,'Acc')}):tr('plan.quietLine',{action:tr('actionPhrase.'+action),duration:duration('quietMinutes',settings.quietMinutes,'Gen')});
  const away=duration('awayMinutes',settings.awayMinutes||10,'Gen');
  const countingDown=()=>[[tr('headline.countdown',{action:progressive(action)})+' ']];
  const waitingForYou=[[tr('headline.waitingForYou')+' '],[tr('headline.toStepAway'),'dim']];

  let tone='preview',badge=tr('badge.preview'),parts,summary;
  switch(plan.phase){
    case 'countdown':tone='countdown';badge=tr('badge.countdown');parts=[...countingDown(),[remaining,'amber']];summary=tr(settings.waitForAway!==false?'summary.countdownAway':'summary.countdown');setSignal('countdown',0,1-done);break;
    case 'timer':if(plan.present){tone='confirm';badge=tr('badge.timer');parts=waitingForYou;summary=tr('summary.timerPresent',{duration:away});setSignal('quiet');break;}
      tone='timer';badge=tr('badge.timer');parts=[...countingDown(),[remaining]];summary=tr('summary.timer');setSignal('timer',0,1-done);break;
    case 'idle':if(plan.present){tone='confirm';badge=tr('badge.confirming');parts=waitingForYou;summary=tr('summary.idlePresent',{duration:away});setSignal('quiet');break;}
      tone='confirm';badge=tr('badge.confirming');parts=[[tr('headline.allQuiet')+' '],['· '+remaining,'dim']];summary=tr('summary.idle');setSignal('progress',0,done);break;
    case 'executing':tone='executing';badge=tr('badge.now');parts=[[progressive(action)+'…']];summary=tr('summary.executing');setSignal('quiet');break;
    case 'waiting':
      tone='armed';badge=tr('badge.armed');
      if(count||background){parts=count?[[chats+' '],[tr('headline.running'),'dim']]:[[tr('headline.background')+' '],[tr('headline.backgroundRunning'),'dim']];setSignal('working',amp);}
      else{parts=[[tr('headline.waiting')+' '],[tr('headline.forVerification'),'dim']];setSignal('quiet');}
      summary=unconnected.length||uncertain?tr('summary.unverified'):planLine+'.';break;
    default:
      summary=planLine+'.';
      if(!snapshot){parts=[[tr('headline.looking')]];summary=tr('summary.oneMoment');setSignal('loading',.3);}
      else if(plan.phase==='completed'){badge=tr('badge.done');parts=[[tr('headline.done')]];summary=tr('summary.requested',{action:actionName(action)});setSignal('quiet');}
      else if(plan.phase==='error'){tone='error';badge=tr('badge.error');parts=[[tr('headline.failed')]];summary=tr('summary.refused');setSignal('quiet');}
      else if(count){parts=[[chats+' '],[tr('headline.running'),'dim']];setSignal('working',amp);}
      else if(background){parts=[[plural('count.tasks',background)+' '],[tr('headline.inBackground'),'dim']];setSignal('working',.55);}
      else if(unconnected.includes('claude')){tone='attention';parts=[['Claude Code '],[tr('headline.notConnected'),'dim']];summary=tr('summary.connectClaude');setSignal('quiet');}
      else if(unconnected.length){tone='attention';parts=[['Codex '],[tr('headline.cantBeRead'),'dim']];summary=tr('summary.checkFolder');setSignal('quiet');}
      else if(uncertain){tone='attention';parts=[[plural('count.items',uncertain)+' '],[tr('headline.unverified',{count:uncertain}),'dim']];setSignal('quiet');}
      else{parts=[[tr('headline.allQuiet')]];setSignal('quiet');}
  }
  $('hero').dataset.tone=tone;text('badge-text',badge);headline(parts);text('summary',summary);

  // Provider chips
  for(const name of ['codex','claude']){
    const on=!!settings[name+'Enabled'],p=snapshot?.[name],chip=document.querySelector(`.provider .picon[data-provider="${name}"]`).parentElement;
    chip.classList.toggle('off',!on);chip.classList.toggle('warn',on&&!!p&&!p.connected);
    text(name+'-count',!on?tr('chip.off'):p?.connected?String(p.chatCount):p?'!':'·');
    const label=name==='codex'?'Codex':'Claude Code';
    chip.title=!on?tr('chip.notWatched',{name:label}):!p?tr('chip.checking',{name:label}):!p.connected?tr('chip.notConnected',{name:label}):tr('chip.running',{name:label,chats:plural('count.chatsRunning',p.chatCount)});chip.setAttribute('aria-label',chip.title);
  }

  // Running list
  const notes=[];if(background&&count)notes.push(plural('note.background',background));if(uncertain)notes.push(tr('note.unverified',{count:uncertain}));
  text('running-note',notes.join(' · '));
  let banner='';
  if(unconnected.includes('claude'))banner=tr('banner.claude');
  else if(unconnected.includes('codex'))banner=tr('banner.codex');
  else if(uncertain)banner=plural('banner.items',uncertain);
  $('banner').classList.toggle('hidden',!banner);text('banner-text',banner);
  text('banner-cta-text',tr(unconnected.length?'banner.setUp':'banner.review'));
  const list=$('chat-list'),items=snapshot?.chats||[];
  const key=JSON.stringify([items.map(c=>[c.provider,c.session,c.title]),!!snapshot,iconKey,language]);
  if(list.dataset.key!==key){
    list.dataset.key=key;list.replaceChildren();
    for(const chat of items){
      const li=document.createElement('li');const provider=chat.provider==='Claude'?'claude':'codex';
      const icon=document.createElement('span');icon.className='picon';fillIcon(icon,provider);
      const title=i18n.chatTitle(chat.title);
      const t=document.createElement('span');t.className='title';t.textContent=title;t.title=title;
      const s=document.createElement('span');s.className='time';s.dataset.since=chat.startedUtc||'';
      const live=document.createElement('i');live.className='live';
      const actions=document.createElement('button');actions.className='chat-actions';actions.type='button';actions.textContent='⋯';actions.setAttribute('aria-label',tr('list.actionsFor',{title}));actions.setAttribute('aria-haspopup','menu');
      const openMenu=()=>{const selected=current?.snapshot?.chats?.find(c=>c.provider===chat.provider&&c.session===chat.session);if(selected)command('chatMenu',{provider:selected.provider,session:selected.session,token:selected.dismissToken||''});};
      actions.addEventListener('click',openMenu);
      li.addEventListener('contextmenu',e=>{e.preventDefault();openMenu();});
      li.addEventListener('keydown',e=>{if(e.key==='ContextMenu'||(e.shiftKey&&e.key==='F10')){e.preventDefault();e.stopPropagation();openMenu();}});
      li.append(icon,t,s,live,actions);list.append(li);
    }
    if(!items.length){
      const li=document.createElement('li');li.className='empty';
      const strong=document.createElement('strong');strong.textContent=tr(snapshot?'list.nothing':'list.looking');
      const small=document.createElement('span');small.textContent=snapshot?tr('list.emptyHint'):'';
      li.append(strong,small);list.append(li);
    }
  }
  for(const n of list.querySelectorAll('.time'))n.textContent=since(n.dataset.since);
  const dismissed=state.dismissed?.count||0;
  $('dismissed-work').classList.toggle('hidden',!dismissed);
  text('dismissed-count',plural('dismissed.count',dismissed));
  $('restore-dismissed').disabled=!!state.dismissed?.reviewing;

  // Plan
  $('plan').classList.toggle('locked',active);
  $('idle-row').classList.toggle('hidden',timerMode);$('timer-row').classList.toggle('hidden',!timerMode);
  for(const b of document.querySelectorAll('.select')){
    const name=b.dataset.menu,v=b.querySelector('.select-value');
    const k=(name==='scheduleMode'?settings.scheduleMode:name==='action'?action:String(settings[name]))+'/'+language;
    if(v.dataset.key===k)continue;v.dataset.key=k;v.replaceChildren();
    if(name==='action'){v.insertAdjacentHTML('beforeend','<svg viewBox="0 0 16 16" aria-hidden="true">'+icons[action]+'</svg>');v.append(actionName(action));}
    else v.append(name==='scheduleMode'?tr('mode.'+settings.scheduleMode):duration(name,settings[name]));
  }
  if(active)closeMenu();

  // CTA
  const cta=$('arm');
  cta.className='cta'+(plan.phase==='countdown'?' cancel':active?' secondary':'');
  cta.disabled=plan.phase==='executing';
  text('cta-text',plan.phase==='countdown'?tr('cta.cancel'):plan.phase==='executing'?progressive(action)+'…':tr(active?'cta.stop':timerMode?'cta.startTimer':'cta.start'));
  text('cta-key',active?'Esc':'↵');$('cta-key').classList.toggle('hidden',plan.phase==='executing');

  // Settings
  for(const name of ['codex','claude']){
    const on=!!settings[name+'Enabled'],p=snapshot?.[name],src=state.sources[name];
    let d;
    if(!on)d=tr(src.detected?'source.foundNotWatched':'source.notFound');
    else if(!p)d=tr('source.checking');
    else if(!p.connected)d=name==='claude'?tr('source.notConnectedYet'):(i18n.monitorText(p.detail)||tr('source.cantBeRead'));
    else d=tr(p.viaWindowOnly?'source.viaWindow':'source.connected',{chats:plural('count.chatsRunning',p.chatCount)});
    text(name+'-detail',d);
    $(name+'-toggle').checked=on;$(name+'-toggle').disabled=active;
    const manual=!!settings[name==='codex'?'codexSessionsOverride':'claudeHomeOverride'];
    text(name+'-folder',src.folder||'—');
    const st=$(name+'-origin');st.className='fstate '+(src.exists?'ok':'missing');
    text(name+'-origin',manual?tr(src.exists?'folder.chosen':'folder.chosenMissing'):src.exists?(src.origin&&src.origin!=='User profile'?tr('folder.foundVia',{origin:origin(src.origin)}):tr('folder.found')):tr(name==='claude'&&src.appInstalled?'folder.willBeCreated':'folder.notFoundYet'));
    document.querySelector('.automatic[data-provider="'+name+'"]').classList.toggle('hidden',!manual);
  }
  const c=snapshot?.claude,hookReady=!!c?.connected&&!c?.viaWindowOnly,installing=state.operation==='install',removing=state.operation==='remove';
  text('install-hooks',tr(installing?'hook.connecting':hookReady?'hook.reconnect':'sources.connect'));
  $('install-hooks').classList.toggle('working',installing);
  $('remove-hooks').classList.toggle('hidden',!hookReady&&!removing);text('remove-hooks',tr(removing?'hook.disconnecting':'sources.disconnect'));
  text('claude-hook-status',tr(installing?'hook.installing':!settings.claudeEnabled?'hook.off':c?.viaWindowOnly&&!installing?'hook.optional':c?.awaitingFirstEvent?'hook.noSessions':hookReady?'hook.receiving':'hook.notConnected'));
  for(const n of document.querySelectorAll('.browse,.automatic,#discover,#install-hooks,#remove-hooks,#check-claude'))n.disabled=active||!!state.operation;
  text('check-claude',tr(state.operation==='check'?'hook.testing':'sources.test'));
  $('check-claude').classList.toggle('hidden',!settings.claudeEnabled);
  const ck=state.claudeCheck,box=$('claude-check');
  box.classList.toggle('hidden',!ck);
  if(ck&&box.dataset.at!==String(ck.at)){
    box.dataset.at=String(ck.at);box.replaceChildren();
    const line=(label,good,detail)=>{const p=document.createElement('div');const s=document.createElement('span');s.className=good?'ok':'bad';s.textContent=(good?'✓ ':'✕ ')+label;p.append(s);if(detail){p.append(' — ');const c=document.createElement('code');c.textContent=detail;p.append(c);}box.append(p);};
    const head=document.createElement('strong');head.textContent=tr(ck.ok?'check.works':'check.problem');box.append(head);
    line(tr('check.inSettings'),ck.found,ck.settingsFile);
    if(ck.found)line(tr('check.allowed'),!ck.disabled);
    if(ck.ran)line(tr('check.records'),ck.ok);
    const note=document.createElement('div');
    note.textContent=ck.ok?tr('check.okNote'):ck.problemKey&&i18n.has(ck.problemKey)?tr(ck.problemKey,ck.problemParams):ck.problem;
    box.append(note);
  }
  const W=state.windows||{};
  $('tray-toggle').checked=settings.minimizeToTray!==false;
  const mac=state.platform==='darwin';
  text('tray-label',tr(mac?'tray.labelMac':'tray.label'));
  text('tray-description',tr(mac?'tray.descriptionMac':'tray.description'));
  $('tray-toggle').setAttribute('aria-label',tr(mac?'tray.labelMac':'tray.label'));
  $('away-toggle').checked=settings.waitForAway!==false;$('away-toggle').disabled=active;text('away-detail',tr('away.detail',{duration:duration('awayMinutes',settings.awayMinutes||10,'Acc')}));$('away-row').classList.toggle('hidden',settings.waitForAway===false);$('away-row').querySelector('.select').disabled=active;
  $('windows-toggle').checked=settings.watchWindows!==false;$('windows-toggle').disabled=active||!W.supported;
  for(const k of ['claude','codex']){
    const w=W[k];let t;
    if(!W.supported)t=tr('win.availableOnWindows');
    else if(settings.watchWindows===false)t=tr('win.off');
    else if(W.error)t=i18n.monitorText(W.error);
    else if(!W.fresh)t=tr('win.starting');
    else if(!w||!w.windows)t=tr('win.notOpen');
    else if(w.busy){const bits=[];if(w.stops.length)bits.push(tr('win.quoted',{text:w.stops[0]}));if(w.running.length)bits.push(plural('win.runningChats',w.running.length));else if(w.working)bits.push(plural('win.busyMarkers',w.working));for(const tab of w.tabs||[])bits.push(tr('win.tabWorking',{tab}));t=tr('win.working',{what:bits.join(', ')});}
    else t=tr('win.idle');
    text('win-'+k,t);
  }
  text('version',tr('about.version',{version:state.version||''}));
  const up=state.update||{},ub=$('update-button');let us,ul=tr('update.check'),ud=false;
  if(!up.configured){us=tr('update.notAvailable');ud=true;}
  else if(up.phase==='checking'){us=tr('update.checking');ud=true;}
  else if(up.phase==='downloading'){us=tr('update.downloading',{version:up.latest,progress:tr('update.percent',{percent:Math.round((up.progress||0)*100)})});ul=tr('update.updating');ud=true;}
  else if(up.phase==='installing'){us=tr('update.restarting');ul=tr('update.updating');ud=true;}
  else if(up.available){us=tr('update.available',{version:up.latest});ul=tr('update.now');ud=ACTIVE.includes(state.plan.phase);}
  else if(up.error)us=up.error;
  else us=tr(up.latest?'update.latest':'update.checksGithub');
  text('update-status',us);if(ub.textContent!==ul)ub.textContent=ul;ub.disabled=ud;
  $('release-page').classList.toggle('hidden',!up.available);
  const theme=['system','light','dark'].includes(settings.theme)?settings.theme:'system';
  $('theme-seg').dataset.value=theme;for(const b of document.querySelectorAll('#theme-seg [data-theme]'))b.setAttribute('aria-pressed',String(b.dataset.theme===theme));
  $('language-seg').dataset.value=language;for(const b of document.querySelectorAll('#language-seg [data-language]'))b.setAttribute('aria-pressed',String(b.dataset.language===language));placeThumb();
  text('platform-monitor-note',tr(state.platform==='darwin'?'about.codexNoteMac':'about.codexNote'));
  const work=$('observed-work'),wk=JSON.stringify(snapshot?.work||[]);
  if(work.dataset.key!==wk){
    work.dataset.key=wk;work.replaceChildren();
    for(const item of snapshot?.work||[]){const row=document.createElement('div');row.className='observed-item';const s=document.createElement('strong');s.textContent=item.provider+' · '+i18n.monitorText(String(item.label||''));const r=document.createElement('span');r.textContent=i18n.monitorText(String(item.reason||'')).replace(/\bin (Sources|Connections)\b/g,'in Settings');row.append(s,r);work.append(row);}
  }
  showNotice(state.error||state.message,!!state.error);
}

// ——— Events ———
document.querySelectorAll('.select').forEach(b=>b.addEventListener('click',e=>{e.stopPropagation();showMenu(b);}));
document.addEventListener('click',e=>{if(openMenu&&!$('menu').contains(e.target))closeMenu();});
window.addEventListener('resize',closeMenu);window.addEventListener('blur',closeMenu);
$('menu').addEventListener('keydown',e=>{
  const items=[...$('menu').querySelectorAll('button')],i=items.indexOf(document.activeElement);
  if(e.key==='ArrowDown'){e.preventDefault();items[(i+1)%items.length].focus();}
  if(e.key==='ArrowUp'){e.preventDefault();items[(i-1+items.length)%items.length].focus();}
  if(e.key==='Tab')e.preventDefault();
});
document.addEventListener('keydown',e=>{
  if(e.key==='Escape'){
    if(openMenu){const b=openMenu;closeMenu();b.focus();return;}
    if(settingsOpen()){openSettings(false);return;}
    if(current&&ACTIVE.includes(current.plan.phase)&&current.plan.phase!=='executing')command('stop');
  }
  if(e.key==='Enter'&&!openMenu&&!settingsOpen()&&current&&!ACTIVE.includes(current.plan.phase)&&!(e.target instanceof HTMLButtonElement)&&!(e.target instanceof HTMLInputElement)){e.preventDefault();command('arm');}
});
document.querySelectorAll('.browse').forEach(b=>b.addEventListener('click',()=>command('browse',{provider:b.dataset.provider})));
document.querySelectorAll('.automatic').forEach(b=>b.addEventListener('click',()=>command('update',{[b.dataset.provider==='codex'?'codexSessionsOverride':'claudeHomeOverride']:''})));
$('tray-toggle').addEventListener('change',()=>command('tray',{on:$('tray-toggle').checked}));
$('away-toggle').addEventListener('change',()=>command('update',{waitForAway:$('away-toggle').checked}));
$('windows-toggle').addEventListener('change',()=>command('update',{watchWindows:$('windows-toggle').checked}));
for(const[n,k]of [['codex','codexEnabled'],['claude','claudeEnabled']])$(n+'-toggle').addEventListener('change',()=>command('update',{[k]:$(n+'-toggle').checked}));
$('arm').addEventListener('click',()=>command(current&&ACTIVE.includes(current.plan.phase)?'stop':'arm'));
for(const id of ['minimize','close','discover','diagnostics','website'])$(id).addEventListener('click',()=>command(id));
$('install-hooks').addEventListener('click',()=>command('install'));
$('update-button').addEventListener('click',()=>command(current?.update?.available?'installUpdate':'checkUpdate'));
$('release-page').addEventListener('click',()=>command('releasePage'));
$('remove-hooks').addEventListener('click',()=>command('remove'));
$('check-claude').addEventListener('click',()=>command('checkClaude'));
$('dismiss-notice').addEventListener('click',()=>{dismissed=$('notice-text').textContent;$('notice').classList.add('hidden');});
$('open-settings').addEventListener('click',()=>openSettings(!settingsOpen()));
document.querySelectorAll('[data-open-settings]').forEach(b=>b.addEventListener('click',()=>openSettings(true)));
$('close-settings').addEventListener('click',()=>openSettings(false));
document.querySelectorAll('#theme-seg [data-theme]').forEach(b=>b.addEventListener('click',()=>{if(current?.settings.theme!==b.dataset.theme)command('theme',{theme:b.dataset.theme});}));
document.querySelectorAll('#language-seg [data-language]').forEach(b=>b.addEventListener('click',()=>{if(language!==b.dataset.language)command('language',{language:b.dataset.language});}));
window.quiet.subscribe(render);command('state');

$('restore-dismissed').addEventListener('click',()=>command('restoreDismissed'));

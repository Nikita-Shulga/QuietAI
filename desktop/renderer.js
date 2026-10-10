'use strict';
const $=id=>document.getElementById(id);
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
const verbs={Sleep:'sleep',Shutdown:'shut down',Restart:'restart',Hibernate:'hibernate',Lock:'lock',Display:'turn off the display'};
const progressive={Sleep:'Sleeping',Shutdown:'Shutting down',Restart:'Restarting',Hibernate:'Hibernating',Lock:'Locking',Display:'Display off'};
const modes={Codex:'After AI finishes',Timer:'On a timer'};
const choices={awayMinutes:[3,5,10,15,30,60],quietMinutes:[1,5,10,15,30,60],timerMinutes:[5,15,30,60,120,240,480],countdownSeconds:[30,60,120]};
const checkSvg='<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3.5 8.4l2.8 2.8 6.2-6.4"/></svg>';

function duration(key,v){
  if(key==='countdownSeconds')return v%60?v+' seconds':(v===60?'1 minute':v/60+' minutes');
  if(v<60)return v===1?'1 minute':v+' minutes';
  const h=v/60;return Number.isInteger(h)?(h===1?'1 hour':h+' hours'):v+' minutes';
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
function plural(n,one,many){return n+' '+(n===1?one:many);}
function clock(sec){sec=Math.max(0,Math.ceil(sec));const h=Math.floor(sec/3600),m=Math.floor(sec%3600/60),s=sec%60;return h?h+':'+String(m).padStart(2,'0')+':'+String(s).padStart(2,'0'):m+':'+String(s).padStart(2,'0');}
function since(iso){const t=Date.parse(iso);if(!Number.isFinite(t)||t<946684800000)return '';const m=Math.floor((Date.now()-t)/60000);if(m<1)return 'just now';if(m<60)return m+' min';return Math.floor(m/60)+' hr '+(m%60)+' min';}
function settingsOpen(){return document.body.classList.contains('settings-open');}
function openSettings(open){closeMenu();document.body.classList.toggle('settings-open',open);$('settings').setAttribute('aria-hidden',String(!open));$('open-settings').classList.toggle('on',open);if(open)requestAnimationFrame(placeThumb);}
function placeThumb(){const seg=$('theme-seg'),b=seg.querySelector('[aria-pressed="true"]'),t=seg.querySelector('.seg-thumb');if(!b||!b.offsetWidth)return;t.style.width=b.offsetWidth+'px';t.style.transform='translateX('+b.offsetLeft+'px)';}
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
  if(name==='scheduleMode')return Object.entries(modes).map(([v,l])=>({value:v,label:l,selected:s.scheduleMode===v}));
  if(name==='action')return current.actions.map(a=>({value:a,label:current.actionNames[a],icon:icons[a],selected:a===s.action}));
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
  const chats=plural(count,'chat','chats');
  const amp=Math.min(1,.5+.13*Math.max(count,background?1:0));
  const planLine=timerMode?`${state.actionNames[action]} in ${duration('timerMinutes',settings.timerMinutes)}`:`Then ${verbs[action]} after ${duration('quietMinutes',settings.quietMinutes)} of quiet`;

  let tone='preview',badge='Preview',parts,summary;
  switch(plan.phase){
    case 'countdown':tone='countdown';badge='Final countdown';parts=[[progressive[action]+' in '],[remaining,'amber']];summary=settings.waitForAway!==false?'Everything finished. Move the mouse or press Esc to stay awake.':'Everything finished. Press Esc to stay awake.';setSignal('countdown',0,1-done);break;
    case 'timer':if(plan.present){tone='confirm';badge='Timer';parts=[['Waiting for you '],['to step away','dim']];summary=`Time’s up — countdown after ${duration('awayMinutes',settings.awayMinutes||10)} without input.`;setSignal('quiet');break;}
      tone='timer';badge='Timer';parts=[[progressive[action]+' in '],[remaining]];summary='Runs on the clock, whatever your AI is doing.';setSignal('timer',0,1-done);break;
    case 'idle':if(plan.present){tone='confirm';badge='Confirming';parts=[['Waiting for you '],['to step away','dim']];summary=`AI is done — countdown after ${duration('awayMinutes',settings.awayMinutes||10)} without input.`;setSignal('quiet');break;}
      tone='confirm';badge='Confirming';parts=[['All quiet '],['· '+remaining,'dim']];summary='Making sure nothing starts again.';setSignal('progress',0,done);break;
    case 'executing':tone='executing';badge='Now';parts=[[progressive[action]+'…']];summary='Good night.';setSignal('quiet');break;
    case 'waiting':
      tone='armed';badge='Armed';
      if(count||background){parts=[[count?chats+' ':'Background work '],[count?'running':'running','dim']];setSignal('working',amp);}
      else{parts=[['Waiting '],['for verification','dim']];setSignal('quiet');}
      summary=unconnected.length||uncertain?'Something can’t be verified yet. See below.':planLine+'.';break;
    default:
      summary=planLine+'.';
      if(!snapshot){parts=[['Looking for your AI…']];summary='One moment.';setSignal('loading',.3);}
      else if(plan.phase==='completed'){badge='Done';parts=[['Done']];summary=state.actionNames[action]+' was requested.';setSignal('quiet');}
      else if(plan.phase==='error'){tone='error';badge='Error';parts=[['That didn’t work']];summary='The system refused the request.';setSignal('quiet');}
      else if(count){parts=[[chats+' '],['running','dim']];setSignal('working',amp);}
      else if(background){parts=[[plural(background,'task','tasks')+' '],['in background','dim']];setSignal('working',.55);}
      else if(unconnected.includes('claude')){tone='attention';parts=[['Claude Code '],['not connected','dim']];summary='Connect it in Settings, or switch it off.';setSignal('quiet');}
      else if(unconnected.length){tone='attention';parts=[['Codex '],['can’t be read','dim']];summary='Check its folder in Settings.';setSignal('quiet');}
      else if(uncertain){tone='attention';parts=[[plural(uncertain,'item','items')+' '],['unverified','dim']];setSignal('quiet');}
      else{parts=[['All quiet']];setSignal('quiet');}
  }
  $('hero').dataset.tone=tone;text('badge-text',badge);headline(parts);text('summary',summary);

  // Provider chips
  for(const name of ['codex','claude']){
    const on=!!settings[name+'Enabled'],p=snapshot?.[name],chip=document.querySelector(`.provider .picon[data-provider="${name}"]`).parentElement;
    chip.classList.toggle('off',!on);chip.classList.toggle('warn',on&&!!p&&!p.connected);
    text(name+'-count',!on?'Off':p?.connected?String(p.chatCount):p?'!':'·');
    const label=name==='codex'?'Codex':'Claude Code';
    chip.title=!on?label+' · not watched (switch it on in Settings)':!p?label+' · checking…':!p.connected?label+' · not connected — see Settings':label+' · '+plural(p.chatCount,'chat','chats')+' running';chip.setAttribute('aria-label',chip.title);
  }

  // Running list
  const notes=[];if(background&&count)notes.push(plural(background,'background task','background tasks'));if(uncertain)notes.push(uncertain+' unverified');
  text('running-note',notes.join(' · '));
  let banner='';
  if(unconnected.includes('claude'))banner='Claude Code isn’t connected';
  else if(unconnected.includes('codex'))banner='Codex can’t be read';
  else if(uncertain)banner=plural(uncertain,'item needs','items need')+' a look';
  $('banner').classList.toggle('hidden',!banner);text('banner-text',banner);
  $('banner').querySelector('.banner-cta').firstChild.textContent=unconnected.length?'Set up':'Review';
  const list=$('chat-list'),items=snapshot?.chats||[];
  const key=JSON.stringify([items.map(c=>[c.provider,c.session,c.title]),!!snapshot,iconKey]);
  if(list.dataset.key!==key){
    list.dataset.key=key;list.replaceChildren();
    for(const chat of items){
      const li=document.createElement('li');const provider=chat.provider==='Claude'?'claude':'codex';
      const icon=document.createElement('span');icon.className='picon';fillIcon(icon,provider);
      const t=document.createElement('span');t.className='title';t.textContent=chat.title;t.title=chat.title;
      const s=document.createElement('span');s.className='time';s.dataset.since=chat.startedUtc||'';
      const live=document.createElement('i');live.className='live';
      li.append(icon,t,s,live);list.append(li);
    }
    if(!items.length){
      const li=document.createElement('li');li.className='empty';
      const strong=document.createElement('strong');strong.textContent=snapshot?'Nothing running':'Looking…';
      const small=document.createElement('span');small.textContent=snapshot?'Chats appear here while Codex or Claude Code work.':'';
      li.append(strong,small);list.append(li);
    }
  }
  for(const n of list.querySelectorAll('.time'))n.textContent=since(n.dataset.since);

  // Plan
  $('plan').classList.toggle('locked',active);
  $('idle-row').classList.toggle('hidden',timerMode);$('timer-row').classList.toggle('hidden',!timerMode);
  for(const b of document.querySelectorAll('.select')){
    const name=b.dataset.menu,v=b.querySelector('.select-value');
    const k=name==='scheduleMode'?settings.scheduleMode:name==='action'?action:String(settings[name]);
    if(v.dataset.key===k)continue;v.dataset.key=k;v.replaceChildren();
    if(name==='action'){v.insertAdjacentHTML('beforeend','<svg viewBox="0 0 16 16" aria-hidden="true">'+icons[action]+'</svg>');v.append(state.actionNames[action]);}
    else v.append(name==='scheduleMode'?modes[settings.scheduleMode]:duration(name,settings[name]));
  }
  if(active)closeMenu();

  // CTA
  const cta=$('arm');
  cta.className='cta'+(plan.phase==='countdown'?' cancel':active?' secondary':'');
  cta.disabled=plan.phase==='executing';
  text('cta-text',plan.phase==='countdown'?'Cancel':plan.phase==='executing'?progressive[action]+'…':active?'Stop':timerMode?'Start timer':'Start monitoring');
  text('cta-key',active?'Esc':'↵');$('cta-key').classList.toggle('hidden',plan.phase==='executing');

  // Settings
  for(const name of ['codex','claude']){
    const on=!!settings[name+'Enabled'],p=snapshot?.[name],src=state.sources[name];
    let d;
    if(!on)d=src.detected?'Found on this computer · not watched':'Not found on this computer';
    else if(!p)d='Checking…';
    else if(!p.connected)d=name==='claude'?'Not connected yet':(p.detail||'Can’t be read');
    else d=(p.viaWindowOnly?'Watching the app window · ':'Connected · ')+plural(p.chatCount,'chat','chats')+' running';
    text(name+'-detail',d);
    $(name+'-toggle').checked=on;$(name+'-toggle').disabled=active;
    const manual=!!settings[name==='codex'?'codexSessionsOverride':'claudeHomeOverride'];
    text(name+'-folder',src.folder||'—');
    const st=$(name+'-origin');st.className='fstate '+(src.exists?'ok':'missing');
    text(name+'-origin',manual?(src.exists?'Chosen by you':'Chosen by you · folder not found'):src.exists?'Found automatically'+(src.origin&&src.origin!=='User profile'?' · '+src.origin:''):(name==='claude'&&src.appInstalled?'Will be created when Claude Code is connected':'Not found yet'));
    document.querySelector('.automatic[data-provider="'+name+'"]').classList.toggle('hidden',!manual);
  }
  const c=snapshot?.claude,hookReady=!!c?.connected&&!c?.viaWindowOnly,installing=state.operation==='install',removing=state.operation==='remove';
  text('install-hooks',installing?'Connecting…':hookReady?'Reconnect':'Connect');
  $('install-hooks').classList.toggle('working',installing);
  $('remove-hooks').classList.toggle('hidden',!hookReady&&!removing);text('remove-hooks',removing?'Disconnecting…':'Disconnect');
  text('claude-hook-status',installing?'Installing the hook…':!settings.claudeEnabled?'Off — switch Claude Code on to connect':c?.viaWindowOnly&&!installing?'Optional — for terminal sessions; the Claude app window is already watched':c?.awaitingFirstEvent?'Connected · no sessions yet':hookReady?'Connected · receiving events':'Not connected');
  for(const n of document.querySelectorAll('.browse,.automatic,#discover,#install-hooks,#remove-hooks,#check-claude'))n.disabled=active||!!state.operation;
  text('check-claude',state.operation==='check'?'Testing…':'Test');
  $('check-claude').classList.toggle('hidden',!settings.claudeEnabled);
  const ck=state.claudeCheck,box=$('claude-check');
  box.classList.toggle('hidden',!ck);
  if(ck&&box.dataset.at!==String(ck.at)){
    box.dataset.at=String(ck.at);box.replaceChildren();
    const line=(label,good,detail)=>{const p=document.createElement('div');const s=document.createElement('span');s.className=good?'ok':'bad';s.textContent=(good?'✓ ':'✕ ')+label;p.append(s);if(detail){p.append(' — ');const c=document.createElement('code');c.textContent=detail;p.append(c);}box.append(p);};
    const head=document.createElement('strong');head.textContent=ck.ok?'Hook works':'Hook problem found';box.append(head);
    line('Hook in Claude Code settings',ck.found,ck.settingsFile);
    if(ck.found)line('Hooks allowed',!ck.disabled);
    if(ck.ran)line('Hook records events',ck.ok);
    const note=document.createElement('div');
    note.textContent=ck.ok?'If a prompt still isn’t tracked: start a new Claude Code session after connecting (sessions opened earlier never load the hook), and make sure it runs on this computer — cloud sessions and Claude’s Chat/Cowork tabs can’t be seen.':ck.problem;
    box.append(note);
  }
  const W=state.windows||{};
  $('tray-toggle').checked=settings.minimizeToTray!==false;
  $('away-toggle').checked=settings.waitForAway!==false;$('away-toggle').disabled=active;$('away-detail').textContent=`Only act after ${duration('awayMinutes',settings.awayMinutes||10)} with no mouse or keyboard use. Using the computer during the final countdown cancels it. The countdown appears on top of everything, on every screen.`;$('away-row').classList.toggle('hidden',settings.waitForAway===false);$('away-row').querySelector('.select').disabled=active;
  $('windows-toggle').checked=settings.watchWindows!==false;$('windows-toggle').disabled=active||!W.supported;
  for(const k of ['claude','codex']){
    const w=W[k];let t;
    if(!W.supported)t='Available on Windows';
    else if(settings.watchWindows===false)t='Off';
    else if(W.error)t=W.error;
    else if(!W.fresh)t='Starting…';
    else if(!w||!w.windows)t='App not open';
    else if(w.busy){const bits=[];if(w.stops.length)bits.push('“'+w.stops[0]+'”');if(w.running.length)bits.push(plural(w.running.length,'running chat','running chats'));else if(w.working)bits.push(plural(w.working,'busy marker','busy markers'));for(const tab of w.tabs||[])bits.push(tab+' working');t='Working — sees '+bits.join(', ');}
    else t='Open · idle';    text('win-'+k,t);
  }
  text('version','Version '+(state.version||''));
  const up=state.update||{},ub=$('update-button');let us,ul='Check for updates',ud=false;
  if(!up.configured){us='Not available in this build.';ud=true;}
  else if(up.phase==='checking'){us='Checking GitHub…';ud=true;}
  else if(up.phase==='downloading'){us='Downloading '+up.latest+'… '+Math.round((up.progress||0)*100)+'%';ul='Updating…';ud=true;}
  else if(up.phase==='installing'){us='Restarting to finish the update…';ul='Updating…';ud=true;}
  else if(up.available){us='Version '+up.latest+' is available. Quiet AI restarts to install it.';ul='Update now';ud=ACTIVE.includes(state.plan.phase);}
  else if(up.error)us=up.error;
  else us=up.latest?'You have the latest version.':'Checks GitHub for new versions.';
  text('update-status',us);if(ub.textContent!==ul)ub.textContent=ul;ub.disabled=ud;
  $('release-page').classList.toggle('hidden',!up.available);
  const theme=['system','light','dark'].includes(settings.theme)?settings.theme:'system';
  $('theme-seg').dataset.value=theme;for(const b of document.querySelectorAll('#theme-seg [data-theme]'))b.setAttribute('aria-pressed',String(b.dataset.theme===theme));placeThumb();
  text('platform-monitor-note',state.platform==='darwin'?'Codex activity comes from its live session locks; chat names from its local database.':'Codex activity comes from its live session locks, read without touching them; chat names from its local database.');
  const work=$('observed-work'),wk=JSON.stringify(snapshot?.work||[]);
  if(work.dataset.key!==wk){
    work.dataset.key=wk;work.replaceChildren();
    for(const item of snapshot?.work||[]){const row=document.createElement('div');row.className='observed-item';const s=document.createElement('strong');s.textContent=item.provider+' · '+item.label;const r=document.createElement('span');r.textContent=String(item.reason||'').replace(/\bin (Sources|Connections)\b/g,'in Settings');row.append(s,r);work.append(row);}
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
window.quiet.subscribe(render);command('state');

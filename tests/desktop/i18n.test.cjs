'use strict';
// Interface language: dictionary parity, Russian typography, monitor-text coverage, English as the
// default, and (with the QA-only jsdom) a live switch that re-renders the window and countdown banner.
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
let JSDOM;try{({JSDOM}=require('jsdom'));}catch{}
const source=path.resolve(__dirname,'../../desktop');
const i18n=require(path.join(source,'i18n'));
const {en,ru}=i18n.strings;
const forms=value=>typeof value==='string'?[value]:Object.values(value);
const holes=text=>[...new Set([...text.matchAll(/\{(\w+)\}/g)].map(m=>m[1]))].sort().join(',');

test('English and Russian have identical keys',()=>{
  assert.deepEqual(Object.keys(ru).sort(),Object.keys(en).sort());
  assert.deepEqual(i18n.LANGUAGES,['en','ru']);
  assert.deepEqual(i18n.NAMES,{en:'English',ru:'Русский'});
});

test('no empty values, complete plural forms and matching placeholders',()=>{
  for(const [lang,dict] of Object.entries(i18n.strings)){
    const categories=new Intl.PluralRules(lang).resolvedOptions().pluralCategories;
    for(const [key,value] of Object.entries(dict)){
      assert.equal(typeof value,typeof en[key],`${lang} ${key}: plural in one language only`);
      if(typeof value==='object')for(const c of categories)assert.ok(typeof value[c]==='string',`${lang} ${key}: missing plural form "${c}"`);
      const expected=holes(forms(en[key]).at(-1));
      for(const form of forms(value)){
        assert.ok(form.trim().length>0,`${lang} ${key}: empty`);
        assert.equal(holes(form),expected,`${lang} ${key}: placeholders differ from English`);
      }
    }
  }
});

test('Russian strings follow Russian typography and keep product names',()=>{
  const allowed=new Set(['Quiet','AI','Claude','Code','Codex','OpenAI','Anthropic','GitHub','Windows','macOS','Mac','Dock','MIT','Esc','Stop','Chat','Cowork','API','SHA256SUMS','txt','disableAllHooks','hooks','Application','Support']);
  for(const [key,value] of Object.entries(ru))for(const form of forms(value)){
    assert.doesNotMatch(form,/["“”„]/,`${key}: use « » quotes`);
    assert.doesNotMatch(form,/\.\.\./,`${key}: use …`);
    assert.doesNotMatch(form,/ - /,`${key}: use an em dash`);
    assert.doesNotMatch(form,/ \u2014/,`${key}: keep the dash on the line before (no-break space)`);
    assert.doesNotMatch(form,/[а-яё]\([а-яё]{1,3}\)/i,`${key}: write real plural forms, not "минут(ы)"`);
    assert.doesNotMatch(form,/\bВы\b|\bВас\b|\bВаш/,`${key}: address the user with lowercase «вы»`);
    const latin=form.replace(/\{\w+\}/g,'').match(/[A-Za-z][A-Za-z0-9]*/g)||[];
    for(const word of latin)assert.ok(allowed.has(word),`${key}: untranslated "${word}"`);
  }
  for(const key of ['action.Sleep','action.Shutdown','action.Hibernate','action.Restart'])assert.ok(ru[key]);
  assert.deepEqual([ru['action.Sleep'],ru['action.Shutdown'],ru['action.Hibernate'],ru['action.Restart'],ru['cta.cancel'],ru['window.settings']],['Спящий режим','Завершение работы','Гибернация','Перезагрузка','Отмена','Настройки']);
});

test('Russian plurals and cases use Intl.PluralRules',()=>{
  const tr=(key,count)=>i18n.tr(key,{count},'ru');
  assert.deepEqual([1,2,5,11,21,22,25,111].map(n=>tr('dur.minutes',n)),['1 минута','2 минуты','5 минут','11 минут','21 минута','22 минуты','25 минут','111 минут']);
  assert.deepEqual([1,2,5].map(n=>tr('dur.minutesAcc',n)),['1 минуту','2 минуты','5 минут']);
  assert.deepEqual([1,2,5].map(n=>tr('dur.minutesGen',n)),['1 минуты','2 минут','5 минут']);
  assert.deepEqual([1,2,5].map(n=>tr('dur.hoursGen',n)),['1 часа','2 часов','5 часов']);
  assert.deepEqual([1,2,5,21].map(n=>tr('count.chats',n)),['1 чат','2 чата','5 чатов','21 чат']);
  assert.deepEqual([1,3,5].map(n=>i18n.tr('notify.countdownTitle',{count:n,action:'Спящий режим'},'ru')),['Спящий режим через 1 секунду','Спящий режим через 3 секунды','Спящий режим через 5 секунд']);
  assert.equal(i18n.tr('update.percent',{percent:45},'ru'),'45\u00a0%');
  assert.equal(i18n.number(1.5,undefined,'ru'),'1,5');
});

test('English is the default and stays exactly as before',()=>{
  assert.equal(i18n.language(),'en');
  for(const value of [undefined,null,'','ru-RU','RU','de',42])assert.equal(i18n.normalize(value),'en');
  const tr=(key,params)=>i18n.tr(key,params,'en');
  assert.equal(tr('plan.quietLine',{action:tr('actionPhrase.Sleep'),duration:tr('dur.minutesGen',{count:5})}),'Then sleep after 5 minutes of quiet');
  assert.equal(tr('plan.timerLine',{action:tr('action.Lock'),duration:tr('dur.hoursAcc',{count:1})}),'Lock screen in 1 hour');
  assert.equal(tr('count.chatsRunning',{count:1}),'1 chat running');
  assert.equal(tr('dismissed.count',{count:2}),'2 entries dismissed · No longer blocking AI plans');
  assert.equal(tr('headline.countdown',{action:tr('progressive.Hibernate')})+' 0:30','Hibernating in 0:30');
  assert.equal(tr('no.such.key'),'no.such.key');
  // English monitor text is shown untouched.
  assert.equal(i18n.monitorText('Turn 1','en'),'Turn 1');
});

// Every sentence the .NET monitor can put in front of the user has a Russian rendering.
const INTERNAL=new Set([
  'SELECT id, COALESCE(NULLIF(name, \'\'), title) FROM threads WHERE archived = 0', // SQL
  'Application Support', // a macOS folder name
  'Unsupported bridge event schema.','Collector lock failed.', // caught internally, replaced by a translated reason
  'Claude connected. Restart or resume open Claude Code sessions to load the hooks.','Quiet AI hooks removed. Other hooks retained.' // replies the app does not show
]);
function monitorLiterals(){
  const files=[...fs.readdirSync(path.resolve(__dirname,'../../src/QuietAI.Core')).filter(f=>f.endsWith('.cs')).map(f=>path.resolve(__dirname,'../../src/QuietAI.Core',f)),path.resolve(__dirname,'../../src/QuietAI.Agent/Program.cs')];
  const out=new Set();
  for(const file of files)for(const m of fs.readFileSync(file,'utf8').matchAll(/(\$?)"((?:[^"\\]|\\.)*)"/g)){
    const text=m[2];if(!/^[A-Z][A-Za-z']* .*[a-z]/.test(text)||INTERNAL.has(text))continue;
    // Fill interpolations and concatenated tails with sample values, as the monitor would.
    let sample=m[1]?text.replace(/\{[^}]+\}/g,'0199c1d2-3'):text;
    if(/error $/.test(sample))sample+='5).';
    else if(/\($/.test(sample))sample+='input) before it can finish.';
    else if(/[: ]$/.test(sample))sample+=sample.endsWith(': ')?'Отказано в доступе':'0199c1d2-3';
    out.add(sample);
  }
  return [...out];
}
test('monitor and main-process records have Russian renderings',()=>{
  const samples=[...monitorLiterals(),'Background bash','Connected','Not connected',
    'App windows can’t be checked','The window watcher is not responding. Turn off “Watch the Claude and Codex apps” in Settings to ignore app windows.',
    'Window watcher could not start: spawn EACCES','Window watcher stopped: spawn EACCES','Claude app · working','Codex app · working','The Claude app shows “Stop response”.','The Codex app shows “Working”.',
    'Claude app · Chat/Cowork working','Claude app · Code working','Codex app · 3 tasks working','Connected. No Claude Code session has run since connecting.',
    'This entry changed or cannot be verified. Review its current activity and try again.','This entry is already dismissed.'];
  assert.ok(samples.length>60,String(samples.length));
  const missing=samples.filter(s=>i18n.monitorText(s,'ru')===s);
  assert.deepEqual(missing,[]);
  assert.equal(i18n.monitorText('Codex app · 3 tasks working','ru'),'Приложение Codex · задач в работе: 3');
  assert.equal(i18n.monitorText('Claude Code is waiting (input) before it can finish.','ru'),'Claude Code ждёт вашего ответа (ввод данных) и без него не сможет закончить.');
  assert.equal(i18n.monitorText('Something new from a future monitor.','ru'),'Something new from a future monitor.');
  // Chat titles are the user's own text: only generated fallback names are translated.
  assert.equal(i18n.chatTitle('Chat 0199c1d2-3','ru'),'Чат 0199c1d2-3');
  assert.equal(i18n.chatTitle('Claude chat 0199c1d2-3','ru'),'Чат Claude 0199c1d2-3');
  assert.equal(i18n.chatTitle('Connected','ru'),'Connected');
  assert.equal(i18n.chatTitle('Fix the login form','ru'),'Fix the login form');
});

// ——— The live switch in the real renderer (optional, needs the QA-only jsdom) ———
function state(language){
  const now=Date.now(),iso=m=>new Date(now-m*60000).toISOString();
  return{platform:'win32',version:'4.2.7',dark:true,error:'',message:'',busy:false,operation:null,
    settings:{codexEnabled:true,claudeEnabled:true,watchWindows:true,waitForAway:true,minimizeToTray:true,scheduleMode:'Codex',action:'Shutdown',quietMinutes:5,countdownSeconds:60,timerMinutes:60,awayMinutes:10,theme:'system',codexSessionsOverride:'',claudeHomeOverride:'',language},
    sources:{codex:{exists:true,detected:true,folder:'C:\\Users\\me\\.codex\\sessions',origin:'CODEX_HOME'},claude:{exists:true,detected:true,folder:'C:\\Users\\me\\.claude',origin:'User profile'}},
    snapshot:{chatCount:2,backgroundRunning:1,scheduled:0,uncertain:1,clear:false,checkedUtc:iso(0),
      chats:[{provider:'Codex',session:'s1',title:'Chat 0199c1d2-3',startedUtc:iso(64)},{provider:'Claude',session:'app-reply',title:'Claude app · Chat/Cowork working',fromWindow:true,startedUtc:iso(3)}],
      codex:{enabled:true,connected:true,chatCount:1},claude:{enabled:true,connected:true,chatCount:1},
      work:[{provider:'Codex',label:'Turn 0199c1d2-3',reason:'Waiting for this turn\'s matching completion or cancellation event.'},{provider:'Claude',label:'Claude Code · waiting for you',reason:'Claude Code is waiting (input) before it can finish.'},{provider:'Claude',label:'App windows can’t be checked',reason:'Window watcher stopped: Отказано в доступе'}]},
    plan:{phase:'disarmed'},actions:['Sleep','Shutdown','Hibernate','Restart','Lock'],actionNames:{},
    update:{phase:'idle',configured:true,available:true,latest:'4.3.0'},icons:{},
    windows:{supported:true,fresh:true,claude:{windows:1,busy:true,stops:['Stop'],running:['Weekly report'],working:0,tabs:['Code']},codex:{windows:1,busy:false,stops:[],running:[],working:0,tabs:[]}},
    dismissed:{count:2},claudeCheck:{at:1,ok:false,found:false,ran:false,settingsFile:'C:\\Users\\me\\.claude\\settings.json',problem:'(English copy)',problemKey:'check.notInFile',problemParams:{file:'C:\\Users\\me\\.claude\\settings.json'}}};
}
function windowFixture(language){
  const dom=new JSDOM(fs.readFileSync(path.join(source,'index.html'),'utf8'),{runScripts:'outside-only',pretendToBeVisual:true,url:'https://quietai.invalid/'}),w=dom.window,commands=[];let listener;
  const st=state(language);
  w.quiet={subscribe(fn){listener=fn;},async command(name,payload){commands.push({name,payload});if(name==='language')st.settings.language=payload.language;return st;}};
  w.eval(fs.readFileSync(path.join(source,'i18n.js'),'utf8'));w.eval(fs.readFileSync(path.join(source,'renderer.js'),'utf8'));
  return{w,d:w.document,st,commands,render:()=>listener(st),close:()=>w.close()};
}
// Visible text and accessible names, minus product names, paths and the user's own chat titles.
function leftoverEnglish(d){
  const skip=n=>n.closest('script,style,.brand-name,.fpath,code,.chat-list .title,[lang="en"]');
  const parts=[];
  const walker=d.createTreeWalker(d.body,4);for(let n;(n=walker.nextNode());)if(!skip(n.parentElement))parts.push(n.nodeValue);
  for(const el of d.querySelectorAll('[aria-label],[title],[data-empty]'))if(!skip(el))parts.push(el.getAttribute('aria-label')||'',el.getAttribute('title')||'',el.getAttribute('data-empty')||'');
  const brands=/Quiet AI|Claude Code|Claude|Codex|OpenAI|Anthropic|GitHub|Windows|macOS|Nikita Shulga|MIT|Esc|Stop|Chat|Cowork|Code|\bCx\b|\bCl\b/g;
  const identifiers=/[A-Z]:\\\S*|\b(CODEX_HOME|CLAUDE_CONFIG_DIR)\b/g; // paths and environment variable names
  return parts.join('\n').replace(identifiers,'').replace(brands,'').match(/[A-Za-z]{2,}/g)||[];
}
test('switching to Russian re-renders the whole window without a restart, and back',{skip:!JSDOM},async()=>{
  const f=windowFixture('en');try{
    await new Promise(setImmediate);const $=id=>f.d.getElementById(id);
    assert.equal(f.d.documentElement.lang,'en');
    assert.equal($('headline').textContent,'2 chats running');
    const english={summary:$('summary').textContent,cta:$('cta-text').textContent,dismissed:$('dismissed-count').textContent,away:$('away-detail').textContent,body:f.d.body.textContent};
    assert.equal(english.summary,'Then shut down after 5 minutes of quiet.');
    assert.equal($('language-seg').querySelector('[aria-pressed="true"]').textContent,'English');
    // The Settings control asks the trusted main process; the reply re-renders in Russian.
    $('language-seg').querySelector('[data-language="ru"]').click();await new Promise(setImmediate);
    assert.deepEqual(JSON.parse(JSON.stringify(f.commands.at(-1))),{name:'language',payload:{language:'ru'}});
    assert.equal(f.d.documentElement.lang,'ru');
    assert.equal($('headline').textContent,'2 чата в работе');
    assert.equal($('summary').textContent,'Затем\u00a0— завершение работы после 5 минут тишины.');
    assert.equal($('cta-text').textContent,'Начать наблюдение');
    assert.equal(f.d.querySelector('[data-menu="action"] .select-value').textContent,'Завершение работы');
    assert.equal(f.d.querySelector('[data-menu="quietMinutes"] .select-value').textContent,'5 минут');
    assert.equal(f.d.querySelector('#chat-list li .title').textContent,'Чат 0199c1d2-3');
    assert.equal(f.d.querySelectorAll('#chat-list li .title')[1].textContent,'Приложение Claude · Chat/Cowork работает');
    assert.equal(f.d.querySelector('#chat-list li .time').textContent,'1 ч 4 мин');
    assert.equal($('dismissed-count').textContent,'2 записи исключены · План их больше не ждёт');
    assert.equal($('away-detail').textContent.startsWith('Действовать, только если мышью и клавиатурой не пользовались 10 минут.'),true);
    assert.equal($('update-status').textContent,'Доступна версия 4.3.0. Для установки Quiet AI перезапустится.');
    assert.equal($('win-claude').textContent,'Работает\u00a0— видно: «Stop», 1 чат в работе, Code: работает');
    assert.match($('observed-work').textContent,/Ход 0199c1d2-3Ждём событие завершения или отмены этого хода\./);
    assert.match($('claude-check').textContent,/Хука Quiet AI нет в файле/);
    assert.equal($('language-seg').querySelector('[aria-pressed="true"]').textContent,'Русский');
    assert.deepEqual(leftoverEnglish(f.d),[]);
    // Armed and final-countdown states.
    f.st.plan={phase:'waiting'};f.render();
    assert.equal($('badge-text').textContent,'Активен');assert.equal($('cta-text').textContent,'Остановить');
    f.st.plan={phase:'countdown',started:Date.now(),until:Date.now()+30000};f.render();
    assert.match($('headline').textContent,/^Выключение через 0:(29|30)$/);assert.equal($('summary').textContent,'Для отмены пошевелите мышью или нажмите Esc.');assert.equal($('cta-text').textContent,'Отмена');
    assert.deepEqual(leftoverEnglish(f.d),[]);
    f.st.snapshot.work=[];f.render();assert.equal(f.d.getElementById('observed-work').dataset.empty,'Ничего\u00a0— план может завершиться, когда вы будете готовы.');
    // And back to English, exactly as before.
    f.st.plan={phase:'disarmed'};f.st.snapshot=state('en').snapshot;f.st.settings.language='en';f.render();
    assert.equal(f.d.documentElement.lang,'en');
    for(const [key,id] of [['summary','summary'],['cta','cta-text'],['dismissed','dismissed-count'],['away','away-detail']])assert.equal($(id).textContent,english[key]);
    assert.equal(f.d.body.textContent,english.body);
  }finally{await new Promise(setImmediate);f.close();}
});
test('the countdown banner follows the chosen language',{skip:!JSDOM},async()=>{
  for(const [language,title,hint,button] of [['en',/^Shutting down in 0:(29|30)$/,'Your AI has finished. Move the mouse or press Cancel to stay awake.','Cancel'],['ru',/^Выключение через 0:(29|30)$/,'ИИ закончил работу. Для отмены пошевелите мышью или нажмите «Отмена».','Отмена']]){
    const dom=new JSDOM(fs.readFileSync(path.join(source,'countdown.html'),'utf8'),{runScripts:'outside-only',pretendToBeVisual:true,url:'https://quietai.invalid/'}),w=dom.window;
    const st={settings:{action:'Shutdown',waitForAway:true,language},plan:{phase:'countdown',started:Date.now(),until:Date.now()+30000,timer:false}};
    w.quiet={subscribe(){},command:async()=>st};
    try{
      w.eval(fs.readFileSync(path.join(source,'i18n.js'),'utf8'));w.eval(fs.readFileSync(path.join(source,'countdown.js'),'utf8'));await new Promise(r=>setTimeout(r,20));
      const d=w.document;assert.match(d.getElementById('title').textContent,title);assert.equal(d.getElementById('hint').textContent,hint);assert.equal(d.getElementById('cancel').textContent,button);assert.equal(d.documentElement.lang,language);
    }finally{w.close();}
  }
});

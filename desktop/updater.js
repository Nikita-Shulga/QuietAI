'use strict';
// ——— Updates from GitHub Releases ———
// Asks GitHub for the latest release of the repository named in package.json ("updateRepo"),
// downloads this platform's ZIP, checks it against the release's SHA256SUMS.txt, unpacks it, and
// hands over to a small script that waits for Quiet AI to quit, swaps the files and reopens it.
// Settings live outside the app folder, so they carry over. No server other than GitHub is used.
const {app,net}=require('electron');
const {execFile,spawn}=require('node:child_process');
const {Readable}=require('node:stream');
const {pipeline}=require('node:stream/promises');
const crypto=require('node:crypto'),fs=require('node:fs'),path=require('node:path');
const pkg=require('./package.json');
const REPO=String(pkg.updateRepo||'');
const VERSION=pkg.version;
const TARGET=(process.platform==='win32'?'win-':process.platform==='darwin'?'mac-':'')+process.arch;

function newer(a,b){ // is version a newer than b?
  const p=v=>String(v).replace(/^v/i,'').split(/[.+-]/).slice(0,3).map(n=>parseInt(n,10)||0);
  const x=p(a),y=p(b);for(let i=0;i<3;i++)if(x[i]!==y[i])return x[i]>y[i];return false;
}
async function get(url,accept){
  const response=await net.fetch(url,{headers:{'User-Agent':'QuietAI/'+VERSION,Accept:accept||'application/octet-stream'},cache:'no-store'});
  if(!response.ok)throw new Error(response.status===404?'No published release was found on GitHub.':'GitHub answered '+response.status+'.');
  return response;
}
// Where the running app lives, and whether it can be replaced in place.
function installation(){
  if(process.platform==='win32'){
    const folder=path.dirname(process.execPath);
    if(!fs.existsSync(path.join(folder,'resources','app','package.json')))return{problem:'This copy of Quiet AI isn’t running from its packaged folder.'};
    return{folder,writable:writable(folder)};
  }
  if(process.platform==='darwin'){
    const bundle=path.resolve(process.execPath,'..','..','..');
    if(!bundle.endsWith('.app'))return{problem:'This copy of Quiet AI isn’t running from an app bundle.'};
    if(bundle.includes('/AppTranslocation/'))return{problem:'Move Quiet AI to the Applications folder, open it from there, then update.'};
    return{bundle,writable:writable(path.dirname(bundle))&&writable(bundle)};
  }
  return{problem:'Updates are available on Windows and macOS.'};
}
function writable(folder){
  const probe=path.join(folder,'.quietai-write-test-'+process.pid);
  try{fs.writeFileSync(probe,'');fs.rmSync(probe);return true;}catch{return false;}
}

async function check(){
  if(!/^[\w.-]+\/[\w.-]+$/.test(REPO))throw new Error('Updates aren’t set up in this build.');
  const release=await (await get('https://api.github.com/repos/'+REPO+'/releases/latest','application/vnd.github+json')).json();
  const latest=String(release.tag_name||'').replace(/^v/i,'');
  const name='QuietAI-'+latest+'-'+TARGET+'.zip';
  const asset=(release.assets||[]).find(a=>a.name===name);
  const sums=(release.assets||[]).find(a=>a.name==='SHA256SUMS.txt');
  return{current:VERSION,latest,available:newer(latest,VERSION),page:release.html_url||'https://github.com/'+REPO+'/releases/latest',
    asset:asset&&{name,url:asset.browser_download_url,size:asset.size},sums:sums&&sums.browser_download_url,notes:String(release.body||'').slice(0,2000)};
}

// Downloads, verifies and unpacks the release next to the installed app (same drive, so the system
// drive doesn't need the space and the Mac swap is a rename); returns the work and unpacked folders.
// progress(fraction) is optional.
async function download(info,place,progress){
  if(!info.asset)throw new Error('The latest release has no package for this computer ('+TARGET+').');
  if(!info.sums)throw new Error('The latest release has no SHA256SUMS.txt, so it can’t be verified.');
  const base=place.folder||path.dirname(place.bundle);
  // The ZIP and its unpacked copy sit side by side until the swap, roughly three times the download.
  try{const s=fs.statfsSync(base),free=s.bavail*s.bsize,need=(info.asset.size||250e6)*3.5;
    if(free<need)throw new Error('Not enough free disk space to update (about '+Math.ceil(need/1e9*10)/10+' GB needed). Free some space and try again.');}
  catch(ex){if(/disk space/.test(ex.message))throw ex;}
  const sums=await (await get(info.sums)).text();
  const line=sums.split(/\r?\n/).map(l=>l.trim().split(/\s+\*?/)).find(p=>p[1]===info.asset.name);
  if(!line||!/^[0-9a-f]{64}$/i.test(line[0]))throw new Error('SHA256SUMS.txt doesn’t list '+info.asset.name+'.');
  const work=fs.mkdtempSync(path.join(base,'.quietai-update-'));
  try{return await fetchAndUnpack(info,work,line[0].toLowerCase(),progress);}
  catch(ex){fs.rmSync(work,{recursive:true,force:true});throw ex;}
}
async function fetchAndUnpack(info,work,expected,progress){
  const zip=path.join(work,info.asset.name);
  const response=await get(info.asset.url);
  const total=Number(response.headers.get('content-length'))||info.asset.size||0;
  const hash=crypto.createHash('sha256');let received=0,last=0;
  const body=Readable.fromWeb(response.body);
  body.on('data',chunk=>{hash.update(chunk);received+=chunk.length;if(progress&&total&&Date.now()-last>250){last=Date.now();progress(received/total);}});
  await pipeline(body,fs.createWriteStream(zip));
  if(hash.digest('hex')!==expected){throw new Error('The download didn’t match its published checksum, so it was discarded.');}
  const out=path.join(work,'unpacked');fs.mkdirSync(out);
  if(process.platform==='win32')await run(path.join(process.env.SystemRoot||'C:\\Windows','System32','tar.exe'),['-xf',zip,'-C',out]);
  else await run('/usr/bin/ditto',['-x','-k',zip,out]);
  fs.rmSync(zip,{force:true});
  const ok=process.platform==='win32'?fs.existsSync(path.join(out,'QuietAI.exe'))&&fs.existsSync(path.join(out,'resources','app','package.json')):fs.existsSync(path.join(out,'Quiet AI.app','Contents','Info.plist'));
  if(!ok)throw new Error('The downloaded package doesn’t look like Quiet AI.');
  return{work,out};
}
function run(file,args){
  return new Promise((resolve,reject)=>execFile(file,args,{windowsHide:true,timeout:300000,maxBuffer:1<<20},(err,_o,stderr)=>err?reject(new Error('Unpacking failed: '+(String(stderr||'').trim().slice(0,200)||err.message))):resolve()));
}

// Starts the hand-over script; resolves once it is running on its own, so the caller can quit.
// Rejects if it couldn't be started, and then the app must stay open.
function install(unpacked,place,log){
  const pid=String(process.pid);
  if(process.platform==='win32'){
    const script=path.join(unpacked.work,'apply-update.ps1');
    fs.copyFileSync(path.join(__dirname,'apply-update.ps1'),script);
    const shell=path.join(process.env.SystemRoot||'C:\\Windows','System32','WindowsPowerShell','v1.0','powershell.exe');
    // A detached child doesn't run, and a normal one dies with the app's job object; start-update.ps1
    // relaunches the hand-over outside the job and reports back (see that file).
    const args=['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',path.join(__dirname,'start-update.ps1'),'-Script',script,'-ProcessId',pid,'-Source',unpacked.out,'-Target',place.folder,'-Log',log];
    return new Promise((resolve,reject)=>execFile(shell,args,{windowsHide:true,timeout:60000},(err,stdout)=>{
      if(err)reject(new Error('The update couldn’t be started: '+(String(stdout||'').trim()||err.message)));else resolve();
    }));
  }
  const script=path.join(unpacked.work,'apply-update.sh');
  fs.copyFileSync(path.join(__dirname,'apply-update.sh'),script);fs.chmodSync(script,0o755);
  spawn('/bin/sh',[script,pid,path.join(unpacked.out,'Quiet AI.app'),place.bundle,log],{detached:true,stdio:'ignore'}).unref();
  return Promise.resolve();
}

// Removes temporary update folders left next to the app by an interrupted or failed update.
function cleanup(){
  const place=installation();if(place.problem)return;
  const base=place.folder||path.dirname(place.bundle);
  try{for(const name of fs.readdirSync(base))if(name.startsWith('.quietai-update-'))fs.rmSync(path.join(base,name),{recursive:true,force:true});}catch{}
}

module.exports={check,download,install,installation,cleanup,newer,REPO,TARGET};

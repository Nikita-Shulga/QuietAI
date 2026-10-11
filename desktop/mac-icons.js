'use strict';
const fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {execFile}=require('node:child_process');
const run=(file,args)=>new Promise((resolve,reject)=>execFile(file,args,{timeout:10000,maxBuffer:1024*1024},(error,stdout)=>error?reject(error):resolve(stdout)));

// Read only known provider bundles, including installations outside /Applications.
async function bundles(names,identifiers){
  const candidates=names.flatMap(name=>['/Applications',path.join(os.homedir(),'Applications')].map(root=>path.join(root,name+'.app')));
  try{
    const query=identifiers.map(id=>`kMDItemCFBundleIdentifier == '${id}'`).join(' || ');
    candidates.push(...(await run('/usr/bin/mdfind',['-0',query])).split('\0').filter(Boolean));
  }catch{} // Spotlight may be unavailable; the standard locations still work.
  return [...new Set(candidates)].filter(file=>file.endsWith('.app')&&fs.existsSync(file));
}

async function icon(bundle,nativeImage){
  let temporary;
  try{
    const info=JSON.parse(await run('/usr/bin/plutil',['-convert','json','-o','-',path.join(bundle,'Contents','Info.plist')]));
    const resources=path.join(bundle,'Contents','Resources');
    const names=[info.CFBundleIconName&&info.CFBundleIconName+'.icns'];
    // Some Codex builds retain ChatGPT's bundle name/icon declaration, while
    // shipping their current Codex artwork as app.icns.
    if(info.CFBundleIdentifier==='com.openai.codex')names.push('app.icns');
    if(info.CFBundleIconFile)names.push(info.CFBundleIconFile,path.extname(info.CFBundleIconFile)?null:info.CFBundleIconFile+'.icns');
    const file=names.filter(name=>typeof name==='string'&&path.basename(name)===name).map(name=>path.join(resources,name)).find(file=>fs.existsSync(file));
    if(!file)return null;
    temporary=fs.mkdtempSync(path.join(os.tmpdir(),'quietai-icon-'));
    const png=path.join(temporary,'icon.png');
    await run('/usr/bin/sips',['-s','format','png',file,'--out',png]);
    const image=nativeImage.createFromPath(png);
    return image.isEmpty()?null:image.resize({width:64,height:64,quality:'best'}).toDataURL();
  }catch{return null;}
  finally{if(temporary)fs.rmSync(temporary,{recursive:true,force:true});}
}
module.exports={bundles,icon};

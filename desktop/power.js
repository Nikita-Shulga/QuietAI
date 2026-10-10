'use strict';
const {execFile} = require('node:child_process');
const path = require('node:path');
const util = require('node:util');
const run=util.promisify(execFile);
const names={Shutdown:'Shut down',Sleep:'Sleep',Hibernate:'Hibernate',Restart:'Restart',Lock:'Lock screen',Display:'Display sleep'};
const actions=process.platform==='darwin'?['Sleep','Shutdown','Restart','Display']:['Sleep','Shutdown','Hibernate','Restart','Lock'];
async function perform(action) {
  if(!actions.includes(action))throw new Error('This action is not available on this platform.');
  if(process.platform==='darwin') {
    if(action==='Display')return run('/usr/bin/pmset',['displaysleepnow']);
    if(action==='Sleep')return run('/usr/bin/pmset',['sleepnow']);
    return run('/usr/bin/osascript',['-e',`tell application "System Events" to ${action==='Shutdown'?'shut down':'restart'}`]);
  }
  const system=path.join(process.env.SystemRoot||'C:\\Windows','System32');
  if(action==='Shutdown'||action==='Restart')return run(path.join(system,'shutdown.exe'),[action==='Shutdown'?'/s':'/r','/t','0'],{windowsHide:true});
  const native=action==='Lock'
    ? '[DllImport("user32.dll")] public static extern bool LockWorkStation();'
    : '[DllImport("powrprof.dll", SetLastError=true)] [return: MarshalAs(UnmanagedType.U1)] public static extern bool SetSuspendState([MarshalAs(UnmanagedType.U1)] bool hibernate,[MarshalAs(UnmanagedType.U1)] bool force,[MarshalAs(UnmanagedType.U1)] bool disableWake);';
  const invoke=action==='Lock'?'[QuietPower]::LockWorkStation()':`[QuietPower]::SetSuspendState($${action==='Hibernate'?'true':'false'},$false,$false)`;
  const script=`Add-Type -TypeDefinition 'using System.Runtime.InteropServices; public static class QuietPower { ${native} }'; if (-not (${invoke})) { throw 'Windows rejected the power action.' }`;
  return run(path.join(system,'WindowsPowerShell','v1.0','powershell.exe'),['-NoProfile','-NonInteractive','-WindowStyle','Hidden','-EncodedCommand',Buffer.from(script,'utf16le').toString('base64')],{windowsHide:true});
}
module.exports={actions,names,perform};

'use strict';
const {contextBridge,ipcRenderer}=require('electron');
contextBridge.exposeInMainWorld('quiet',{
  command:(command,payload)=>ipcRenderer.invoke('quiet:command',command,payload),
  subscribe:callback=>{ipcRenderer.on('quiet:state',(_event,state)=>callback(state));},
  platform:process.platform
});

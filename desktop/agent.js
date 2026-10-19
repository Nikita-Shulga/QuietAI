'use strict';
const {spawn} = require('node:child_process');
const readline = require('node:readline');
const {tr} = require('./i18n');
class Agent {
  constructor(executable, stateRoot) { this.executable=executable; this.stateRoot=stateRoot; this.serial=0; this.pending=new Map(); }
  start() {
    if (this.process && !this.process.killed) return;
    const child=this.process=spawn(this.executable,[this.stateRoot],{windowsHide:true,stdio:['pipe','pipe','pipe']});
    child.stderr.on('data',()=>{});
    readline.createInterface({input:child.stdout}).on('line',line=>{
      try { const result=JSON.parse(line), request=this.pending.get(result.id); if(!request)return; this.pending.delete(result.id); clearTimeout(request.timer); result.ok?request.resolve(result):request.reject(new Error(result.error || tr('error.monitorFailed'))); } catch { }
    });
    const fail=()=>{ if(this.process===child)this.process=null; for(const request of this.pending.values()){clearTimeout(request.timer);request.reject(new Error(tr('error.monitorStopped')));} this.pending.clear(); };
    child.on('error',fail); child.on('exit',fail); child.stdin.on('error',()=>{});
  }
  request(command,settings) {
    this.start();
    return new Promise((resolve,reject)=>{
      const id=++this.serial;
      const timer=setTimeout(()=>{this.pending.delete(id);reject(new Error(tr('error.monitorSlow')));},90000);
      this.pending.set(id,{resolve,reject,timer});
      this.process.stdin.write(JSON.stringify({id,command,settings})+'\n');
    });
  }
  close() { if(this.process){this.process.stdin.end();this.process.kill();} }
}
module.exports=Agent;

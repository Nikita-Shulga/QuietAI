'use strict';
// Test double: records the requested action instead of touching the computer.
const fs=require('node:fs');
const names={Shutdown:'Shut down',Sleep:'Sleep',Hibernate:'Hibernate',Restart:'Restart',Lock:'Lock screen',Display:'Display sleep'};
const actions=['Sleep','Shutdown','Hibernate','Restart','Lock'];
async function perform(action){fs.appendFileSync(process.env.QA_LOG,JSON.stringify({t:Date.now(),power:action})+'\n');}
module.exports={actions,names,perform};

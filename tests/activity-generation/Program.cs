using System.Reflection;
using System.Text.Json;
using QuietAI.Core;
var root=Path.Combine(Path.GetTempPath(),"quietai-activity-fixture-"+Guid.NewGuid());Directory.CreateDirectory(root);
var passed=0;
void Check(bool condition,string name){if(!condition)throw new Exception(name);Console.WriteLine("PASS "+name);passed++;}
try {
 var log=Path.Combine(root,"rollout.jsonl");
 File.WriteAllText(log,"{\"timestamp\":\"2026-10-11T12:00:00Z\",\"type\":\"event_msg\",\"payload\":{\"type\":\"task_started\",\"turn_id\":\"fixture-turn\"}}\n");
 var state=new LogState{Path=log,Provider="Codex"};EventLog.Read(state,EventLog.ConsumeCodex,default);
 Check(state.Work.Count==1,"fixture root recorded");var token=EventLog.ActivityToken(state);var eventUtc=state.Work.Values.Single().LastEventUtc;
 EventLog.Read(state,EventLog.ConsumeCodex,default);Check(EventLog.ActivityToken(state)==token,"unchanged scan has stable token");
 File.AppendAllText(log,"{\"type\":\"response_item\",\"payload\":{\"type\":\"message\",\"content\":[]}}\n");EventLog.Read(state,EventLog.ConsumeCodex,default);
 Check(EventLog.ActivityToken(state)!=token,"non-lifecycle append changes activity generation");Check(state.Work.Values.Single().LastEventUtc==eventUtc,"root timestamp alone would miss append");
 token=EventLog.ActivityToken(state);File.AppendAllText(log,"{\"type\":\"event_msg\"");EventLog.Read(state,EventLog.ConsumeCodex,default);Check(state.PartialLine&&EventLog.ActivityToken(state)!=token,"partial writes change generation and remain uncertain");
 token=EventLog.ActivityToken(state);File.WriteAllText(log,"{\"type\":\"response_item\"}\n");EventLog.Read(state,EventLog.ConsumeCodex,default);Check(EventLog.ActivityToken(state)!=token&&state.Work.Values.Any(w=>w.Status==WorkStatus.Uncertain),"truncate/rewrite changes generation and retains uncertainty");
 var claude=Path.Combine(root,"claude");Directory.CreateDirectory(Path.Combine(claude,"sessions"));var file=Path.Combine(claude,"sessions",Environment.ProcessId+".json");
 void Live(string status,long at)=>File.WriteAllText(file,JsonSerializer.Serialize(new{pid=Environment.ProcessId,sessionId="fixture-session",name="fixture",status,statusUpdatedAt=at}));
 var item=new WorkItem("Claude:fixture:prompt:one","Claude","fixture-session","prompt",WorkStatus.Running,"Working",DateTime.UtcNow){ActivityToken="log:1"};
 var engine=new MonitorEngine(Path.Combine(root,"cache"));var options=new MonitorOptions(false,root,true,claude,Path.Combine(root,"cache"),new HashSet<string>());
 var method=typeof(MonitorEngine).GetMethod("WithClaudeLiveSessions",BindingFlags.Instance|BindingFlags.NonPublic)!;
 List<WorkItem> Read(List<WorkItem> work)=>(List<WorkItem>)method.Invoke(engine,new object[]{work,options})!;
 var busyAt=DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();Live("busy",busyAt);var initial=Read(new(){item}).Single();Check(initial.ActivityToken.StartsWith("log:1|"),"hooked root includes independent live generation");
 Check(Read(new(){item}).Single().ActivityToken==initial.ActivityToken,"unchanged live file stable");
 Live("busy",busyAt);File.SetLastWriteTimeUtc(file,DateTime.UtcNow.AddSeconds(10));Check(Read(new(){item}).Single().ActivityToken==initial.ActivityToken,"heartbeat-only rewrite does not invalidate status generation");
 Live("waiting",DateTimeOffset.UtcNow.ToUnixTimeMilliseconds()+1);var waiting=Read(new(){item}).Single();Check(waiting.ActivityToken!=initial.ActivityToken&&waiting.LastEventUtc==item.LastEventUtc,"live state change restores even unchanged hooked root timestamp");
 var liveOnly=Read(new()).Single();Check(liveOnly.ActivityToken.StartsWith("live:")&&liveOnly.Status==WorkStatus.Running,"unhooked live-only root carries generation");
 var noMetadata=Read(new(){item with{ActivityToken=""}}).Single();Check(noMetadata.ActivityToken=="","untrusted deleted root does not gain dismissible token");
 File.WriteAllText(file,JsonSerializer.Serialize(new{pid=Environment.ProcessId,sessionId="fixture-session",name="fixture",status="busy"}));var fallback=Read(new(){item}).Single().ActivityToken;File.SetLastWriteTimeUtc(file,DateTime.UtcNow.AddSeconds(20));Check(Read(new(){item}).Single().ActivityToken!=fallback,"missing status timestamp uses conservative mtime generation");
 File.Delete(file);Check(Read(new(){item}).Count==0,"existing live-process retirement unchanged");
 Console.WriteLine($"{passed} managed fixture checks passed; only generated temp files used");
} finally {Directory.Delete(root,true);}

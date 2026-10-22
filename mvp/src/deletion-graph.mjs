import {createHash} from 'node:crypto';
import {AppError} from './config.mjs';
export const canonical = x => x === null || typeof x !== 'object' ? JSON.stringify(x) : Array.isArray(x) ? '['+x.map(canonical).join(',')+']' : '{'+Object.keys(x).sort().map(k=>JSON.stringify(k)+':'+canonical(x[k])).join(',')+'}';
export function auditGraph(g) {
 const topics=new Set(g.topics.map(r=>r.id));
 const tasks=new Map(g.tasks.map(r=>[r.id,r])),trials=new Map(g.trials.map(r=>[r.id,r])),grades=new Map(g.grades.map(r=>[r.id,r]));
 const family=(table,id)=>table==='tasks'?tasks.get(id)?.family_id:table==='trials'?tasks.get(trials.get(id)?.task_id)?.family_id:tasks.get(trials.get(grades.get(id)?.trial_id)?.task_id)?.family_id;
 const blockers=[];
 const add=(table,row,field,targetTable,target)=>blockers.push({relation:`${table}.${field}`,source_id:row.id||row.task_id,target_id:target??null,source_family:family(table,row.id||row.task_id)??(table==='task_topics'?tasks.get(row.task_id)?.family_id:null),target_family:family(targetTable,target)??null});
 for(const r of g.tasks) {
  const root=tasks.get(r.family_id),prev=tasks.get(r.previous_task_id);
  if(!root || root.family_id!==root.id || root.version!==1 || root.previous_task_id!==null) add('tasks',r,'family_id','tasks',r.family_id);
  if(r.version===1 ? r.id!==r.family_id || r.previous_task_id!==null : !prev || prev.family_id!==r.family_id || prev.version!==r.version-1) add('tasks',r,'previous_task_id','tasks',r.previous_task_id);
 }
 for(const r of g.trials) {
  if(!tasks.has(r.task_id))add('trials',r,'task_id','tasks',r.task_id);
  if(r.based_on_grade_id && (!grades.has(r.based_on_grade_id)||family('trials',r.id)!==family('grades',r.based_on_grade_id)))add('trials',r,'based_on_grade_id','grades',r.based_on_grade_id);
 }
 for(const r of g.grades)if(!trials.has(r.trial_id))add('grades',r,'trial_id','trials',r.trial_id);
 for(const [table,map,field,owner] of [['trials',trials,'supersedes_trial_id','task_id'],['grades',grades,'supersedes_grade_id','trial_id']]) {
  for(const r of map.values())if(r[field]) {
   const p=map.get(r[field]);const seen=new Set([r.id]);let cur=p,cycle=false;
   while(cur) {if(seen.has(cur.id)){cycle=true;break;}seen.add(cur.id);cur=map.get(cur[field]);}
   if(!p||p[owner]!==r[owner]||cycle)add(table,r,field,table,r[field]);
  }
 }
 for(const r of g.task_topics){if(!tasks.has(r.task_id))add('task_topics',r,'task_id','tasks',r.task_id);if(!topics.has(r.topic_id))add('task_topics',r,'topic_id','topics',r.topic_id);}
 return blockers;
}
export function makePlan(g, taskID, identity, target) {
 const selected=g.tasks.find(r=>r.id===taskID);if(!selected)throw new AppError('NOT_FOUND','题目不存在。',3);
 const family=selected.family_id,tasks=g.tasks.filter(r=>r.family_id===family),taskIDs=new Set(tasks.map(r=>r.id));
 const trials=g.trials.filter(r=>taskIDs.has(r.task_id)),trialIDs=new Set(trials.map(r=>r.id));
 const grades=g.grades.filter(r=>trialIDs.has(r.trial_id));const links=g.task_topics.filter(r=>taskIDs.has(r.task_id));
 const blockers=auditGraph(g).filter(r=>r.source_family===family||r.target_family===family||taskIDs.has(r.source_id)||taskIDs.has(r.target_id));
 const rows={tasks,trials,grades,task_topics:links};for(const v of Object.values(rows))v.sort((a,b)=>{const x=a.id??`${a.task_id}:${a.topic_id}`,y=b.id??`${b.task_id}:${b.topic_id}`;return x<y?-1:x>y?1:0;});
 const counts=Object.fromEntries(Object.entries(rows).map(([k,v])=>[k,v.length]));
 const plan={family_id:family,title:[...tasks].sort((a,b)=>b.version-a.version)[0]?.title,counts,can_delete:!blockers.length,blockers};
 if(plan.can_delete)plan.plan_token='sqlite-delete-v1:'+createHash('sha256').update(canonical({protocol:'task-delete-v1',provider:'sqlite',version:2,identity,target,family,rows})).digest('hex');
 return plan;
}

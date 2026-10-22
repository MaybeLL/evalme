import {randomUUID} from 'node:crypto';
const id=()=>randomUUID();
export async function records(s) {
 const topic=id(),a=id(),b=id(),a2=id(),trial=id(),grade=id(),repeat=id();
 await s.createTopic({id:topic,name:topic});
 await s.createTask({id:a,prompt:'first',topic_ids:[topic]});
 await s.createTask({id:b,prompt:'keep',topic_ids:[topic]});
 await s.reviseTask({id:a2,previous_task_id:a,prompt:'second',title:'second',reference_answer:null,rubric:null,background:null,source:null,topic_ids:[topic]});
 await s.recordTrial({id:trial,task_id:a,answer:'answer',answer_kind:'verbatim',conditions:{hint_status:'none',hints:[]}});
 await s.submitGrade({id:grade,trial_id:trial,basis:{mode:'task_only',reasoning:'test'},feedback:'feedback',findings:[{id:'f',kind:'correct',statement:'answer',evidence:[{target:'answer',quote:'answer'}]}],uncertainties:[],evaluator:{name:'test'}});
 await s.recordTrial({id:repeat,task_id:a2,answer:'again',answer_kind:'verbatim',based_on_grade_id:grade,conditions:{hint_status:'provided',hints:['feedback']}});
 return {topic,a,b,a2,trial,grade,repeat};
}
export async function corrections(s,r) {
 const corrected=id(),g1=id(),g2=id();
 await s.recordTrial({id:corrected,task_id:r.a2,answer:'更正 ✨',answer_kind:'verbatim',supersedes_trial_id:r.repeat,correction_reason:'原文更正',conditions:{hint_status:'provided',hints:['feedback']},based_on_grade_id:r.grade});
 const grade={trial_id:r.repeat,basis:{mode:'task_only',reasoning:'test'},feedback:'反馈',findings:[],uncertainties:['uncertain'],evaluator:{name:'test'}};
 // Missing/uncertain findings may have no quote; retain real evidence explicitly.
 grade.findings=[{id:'f',kind:'uncertain',statement:'待确认',evidence:[{target:'answer',quote:'again'}]}];
 await s.submitGrade({id:g1,...grade});await s.submitGrade({id:g2,...grade,supersedes_grade_id:g1,correction_reason:'评价更正'});
 return {corrected,g1,g2};
}
export async function fixedRecords(s) {
 const a='11111111-1111-4111-8111-111111111111',trial='22222222-2222-4222-8222-222222222222',grade='33333333-3333-4333-8333-333333333333';
 await s.createTask({id:a,title:'题目 ✨',prompt:'固定向量',reference_answer:null,rubric:null,background:null,source:{description:'来源',excerpt_kind:'summary'},topic_ids:[]});
 await s.recordTrial({id:trial,task_id:a,answer:'中文 🧪',answer_kind:'verbatim',occurred_at:'2026-10-22T06:00:00.000Z',conditions:{hint_status:'none',hints:[]}});
 await s.submitGrade({id:grade,trial_id:trial,basis:{mode:'task_only',reasoning:'依据'},feedback:'反馈',findings:[{id:'f',kind:'correct',statement:'内容',evidence:[{target:'answer',quote:'中文'}]}],uncertainties:[],evaluator:{name:'test'}});
 for(const table of ['tasks','trials','grades'])await s.query(`UPDATE ${table} SET created_at=?`,['2026-10-22T06:00:00.000Z']);
 return a;
}

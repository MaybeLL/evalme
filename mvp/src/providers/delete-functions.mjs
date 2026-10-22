// Shared source for installation and verification; never trust function names alone.
export const functions = [
 {name:'_delete_audit',args:'',volatility:'s',returns:'jsonb',body:`
DECLARE result jsonb;
BEGIN
 WITH RECURSIVE
 tc AS (SELECT id AS start,id,supersedes_trial_id AS next,ARRAY[id] AS path,false AS cycle FROM evalme.trials
 UNION ALL SELECT c.start,t.id,t.supersedes_trial_id,c.path||t.id,t.id=ANY(c.path) FROM tc c JOIN evalme.trials t ON t.id=c.next WHERE NOT c.cycle),
 gc AS (SELECT id AS start,id,supersedes_grade_id AS next,ARRAY[id] AS path,false AS cycle FROM evalme.grades
 UNION ALL SELECT c.start,g.id,g.supersedes_grade_id,c.path||g.id,g.id=ANY(c.path) FROM gc c JOIN evalme.grades g ON g.id=c.next WHERE NOT c.cycle),
 edges AS (
 SELECT 'tasks.family_id' AS relation,t.id AS source_id,t.family_id AS target_id,t.family_id AS source_family,r.family_id AS target_family FROM evalme.tasks t LEFT JOIN evalme.tasks r ON r.id=t.family_id WHERE r.id IS NULL OR r.family_id<>r.id OR r.version<>1 OR r.previous_task_id IS NOT NULL
 UNION ALL SELECT 'tasks.previous_task_id',t.id,t.previous_task_id,t.family_id,p.family_id FROM evalme.tasks t LEFT JOIN evalme.tasks p ON p.id=t.previous_task_id WHERE (t.version=1 AND (t.id<>t.family_id OR t.previous_task_id IS NOT NULL)) OR (t.version>1 AND (p.id IS NULL OR p.family_id<>t.family_id OR p.version<>t.version-1))
 UNION ALL SELECT 'trials.task_id',r.id,r.task_id,NULL::uuid,NULL::uuid FROM evalme.trials r LEFT JOIN evalme.tasks t ON t.id=r.task_id WHERE t.id IS NULL
 UNION ALL SELECT 'grades.trial_id',g.id,g.trial_id,NULL::uuid,NULL::uuid FROM evalme.grades g LEFT JOIN evalme.trials r ON r.id=g.trial_id WHERE r.id IS NULL
 UNION ALL SELECT 'task_topics.task_id',x.task_id,x.task_id,NULL::uuid,NULL::uuid FROM evalme.task_topics x LEFT JOIN evalme.tasks t ON t.id=x.task_id WHERE t.id IS NULL
 UNION ALL SELECT 'task_topics.topic_id',x.task_id,x.topic_id,t.family_id,NULL::uuid FROM evalme.task_topics x JOIN evalme.tasks t ON t.id=x.task_id LEFT JOIN evalme.topics p ON p.id=x.topic_id WHERE p.id IS NULL
 UNION ALL SELECT 'trials.based_on_grade_id',r.id,r.based_on_grade_id,t.family_id,bt.family_id FROM evalme.trials r LEFT JOIN evalme.tasks t ON t.id=r.task_id LEFT JOIN evalme.grades g ON g.id=r.based_on_grade_id LEFT JOIN evalme.trials br ON br.id=g.trial_id LEFT JOIN evalme.tasks bt ON bt.id=br.task_id WHERE r.based_on_grade_id IS NOT NULL AND (g.id IS NULL OR t.family_id IS DISTINCT FROM bt.family_id)
 UNION ALL SELECT 'trials.supersedes_trial_id',r.id,r.supersedes_trial_id,t.family_id,pt.family_id FROM evalme.trials r LEFT JOIN evalme.tasks t ON t.id=r.task_id LEFT JOIN evalme.trials p ON p.id=r.supersedes_trial_id LEFT JOIN evalme.tasks pt ON pt.id=p.task_id WHERE r.supersedes_trial_id IS NOT NULL AND (p.id IS NULL OR p.task_id<>r.task_id OR EXISTS(SELECT 1 FROM tc WHERE start=r.id AND cycle))
 UNION ALL SELECT 'grades.supersedes_grade_id',g.id,g.supersedes_grade_id,t.family_id,pt.family_id FROM evalme.grades g JOIN evalme.trials r ON r.id=g.trial_id JOIN evalme.tasks t ON t.id=r.task_id LEFT JOIN evalme.grades p ON p.id=g.supersedes_grade_id LEFT JOIN evalme.trials pr ON pr.id=p.trial_id LEFT JOIN evalme.tasks pt ON pt.id=pr.task_id WHERE g.supersedes_grade_id IS NOT NULL AND (p.id IS NULL OR p.trial_id<>g.trial_id OR EXISTS(SELECT 1 FROM gc WHERE start=g.id AND cycle))
 ) SELECT COALESCE(jsonb_agg(to_jsonb(e) ORDER BY relation,source_id,target_id),'[]'::jsonb) INTO result FROM edges e;
 RETURN result;
END`},
 {name:'_delete_plan',args:'task_id uuid',volatility:'s',returns:'jsonb',body:`
DECLARE family uuid; identity uuid; payload jsonb; blocked jsonb; counts jsonb; title text; result jsonb;
BEGIN
 SELECT t.family_id INTO family FROM evalme.tasks t WHERE t.id=task_id;
 IF family IS NULL THEN RAISE EXCEPTION USING ERRCODE='P0002',MESSAGE='NOT_FOUND'; END IF;
 SELECT database_uuid INTO STRICT identity FROM evalme.database_identity WHERE singleton=1;
 SELECT COALESCE(jsonb_agg(b),'[]'::jsonb) INTO blocked FROM jsonb_array_elements(evalme._delete_audit()) b WHERE b->>'source_family'=family::text OR b->>'target_family'=family::text;
 SELECT jsonb_build_object(
 'protocol','task-delete-v1','provider','postgres','version',2,'identity',identity,'database',current_database(),'family',family,
 'tasks',(SELECT COALESCE(jsonb_agg(to_jsonb(t) ORDER BY t.id),'[]'::jsonb) FROM evalme.tasks t WHERE family_id=family),
 'trials',(SELECT COALESCE(jsonb_agg(to_jsonb(r) ORDER BY r.id),'[]'::jsonb) FROM evalme.trials r JOIN evalme.tasks t ON t.id=r.task_id WHERE t.family_id=family),
 'grades',(SELECT COALESCE(jsonb_agg(to_jsonb(g) ORDER BY g.id),'[]'::jsonb) FROM evalme.grades g JOIN evalme.trials r ON r.id=g.trial_id JOIN evalme.tasks t ON t.id=r.task_id WHERE t.family_id=family),
 'task_topics',(SELECT COALESCE(jsonb_agg(to_jsonb(x) ORDER BY x.task_id,x.topic_id),'[]'::jsonb) FROM evalme.task_topics x JOIN evalme.tasks t ON t.id=x.task_id WHERE t.family_id=family)) INTO payload;
 counts=jsonb_build_object('tasks',jsonb_array_length(payload->'tasks'),'trials',jsonb_array_length(payload->'trials'),'grades',jsonb_array_length(payload->'grades'),'task_topics',jsonb_array_length(payload->'task_topics'));
 SELECT t.title INTO title FROM evalme.tasks t WHERE t.family_id=family ORDER BY version DESC LIMIT 1;
 result=jsonb_build_object('family_id',family,'title',title,'counts',counts,'can_delete',jsonb_array_length(blocked)=0,'blockers',blocked);
 IF jsonb_array_length(blocked)=0 THEN result=result||jsonb_build_object('plan_token','pg-delete-v1:'||encode(sha256(convert_to(payload::text,'UTF8')),'hex')); END IF;
 RETURN result;
END`},
 {name:'preview_task_delete',args:'task_id uuid',volatility:'s',returns:'jsonb',public:true,body:`BEGIN RETURN evalme._delete_plan(task_id); END`},
 {name:'delete_task_family',args:'task_id uuid, plan_token text',volatility:'v',returns:'jsonb',public:true,body:`
DECLARE plan jsonb; family uuid;
BEGIN
 IF current_setting('transaction_isolation')<>'read committed' THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='DELETE_ISOLATION_REQUIRED'; END IF;
 PERFORM set_config('lock_timeout','5000ms',true);
 PERFORM pg_advisory_xact_lock(109539641,1);
 LOCK TABLE evalme.schema_meta,evalme.database_identity,evalme.topics,evalme.tasks,evalme.task_topics,evalme.trials,evalme.grades IN SHARE ROW EXCLUSIVE MODE;
 plan=evalme._delete_plan(task_id);
 IF NOT (plan->>'can_delete')::boolean THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='DELETE_BLOCKED_REFERENCES',DETAIL=(plan->'blockers')::text; END IF;
 IF plan_token IS NULL OR plan_token IS DISTINCT FROM plan->>'plan_token' THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='DELETE_PLAN_CHANGED'; END IF;
 family=(plan->>'family_id')::uuid;
 SET CONSTRAINTS evalme.tasks_family_id_fkey,evalme.tasks_previous_task_id_fkey,evalme.trials_task_id_fkey,evalme.trials_based_on_grade_fk,evalme.trials_supersedes_trial_id_fkey,evalme.grades_trial_id_fkey,evalme.grades_supersedes_grade_id_fkey,evalme.task_topics_task_id_fkey DEFERRED;
 DELETE FROM evalme.task_topics x WHERE x.task_id IN(SELECT id FROM evalme.tasks WHERE family_id=family);
 DELETE FROM evalme.grades WHERE trial_id IN(SELECT r.id FROM evalme.trials r JOIN evalme.tasks t ON t.id=r.task_id WHERE t.family_id=family);
 DELETE FROM evalme.trials x WHERE x.task_id IN(SELECT id FROM evalme.tasks WHERE family_id=family);
 DELETE FROM evalme.tasks WHERE family_id=family;
 SET CONSTRAINTS evalme.tasks_family_id_fkey,evalme.tasks_previous_task_id_fkey,evalme.trials_task_id_fkey,evalme.trials_based_on_grade_fk,evalme.trials_supersedes_trial_id_fkey,evalme.grades_trial_id_fkey,evalme.grades_supersedes_grade_id_fkey,evalme.task_topics_task_id_fkey IMMEDIATE;
 RETURN jsonb_build_object('deleted',true,'family_id',family,'counts',plan->'counts');
END`},
 {name:'_feedback_family',args:'',volatility:'v',returns:'trigger',body:`
BEGIN
 IF NEW.based_on_grade_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM evalme.tasks a JOIN evalme.grades g ON g.id=NEW.based_on_grade_id JOIN evalme.trials r ON r.id=g.trial_id JOIN evalme.tasks b ON b.id=r.task_id WHERE a.id=NEW.task_id AND a.family_id=b.family_id) THEN RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='FEEDBACK_FAMILY_MISMATCH'; END IF;
 RETURN NEW;
END`},
];
export const signature = f => f.args ? f.args.split(',').map(x=>x.trim().split(' ').at(-1)).join(',') : '';
export const createFunction = f => `CREATE FUNCTION evalme.${f.name}(${f.args}) RETURNS ${f.returns} LANGUAGE plpgsql ${f.volatility==='s'?'STABLE':'VOLATILE'} SECURITY DEFINER SET search_path=pg_catalog,pg_temp SET TimeZone='UTC' SET DateStyle='ISO,YMD' AS $body$${f.body}$body$`;
export const foreignKeys=[['tasks','tasks_family_id_fkey'],['tasks','tasks_previous_task_id_fkey'],['trials','trials_task_id_fkey'],['trials','trials_based_on_grade_fk'],['trials','trials_supersedes_trial_id_fkey'],['grades','grades_trial_id_fkey'],['grades','grades_supersedes_grade_id_fkey'],['task_topics','task_topics_task_id_fkey']];

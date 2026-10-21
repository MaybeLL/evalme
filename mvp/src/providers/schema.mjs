export const JSON_COLUMNS = new Set([
  "rubric",
  "source",
  "process",
  "conditions",
  "basis",
  "findings",
  "uncertainties",
  "evaluator",
]);
export function schema(dialect) {
  const id = dialect === "postgres" ? "UUID" : "TEXT";
  const json = dialect === "postgres" ? "JSONB" : "TEXT";
  const time = dialect === "postgres" ? "TIMESTAMPTZ" : "TEXT";
  const common = `id ${id} PRIMARY KEY, schema_version INTEGER NOT NULL CHECK(schema_version=1), payload_hash TEXT NOT NULL, created_at ${time} NOT NULL`;
  const j = (name, nullable = false) =>
    `${name} ${json}${nullable ? "" : " NOT NULL"}${dialect === "sqlite" ? ` CHECK(${nullable ? `${name} IS NULL OR ` : ""}json_valid(${name}))` : ""}`;
  return [
    "CREATE TABLE IF NOT EXISTS schema_meta (version INTEGER PRIMARY KEY CHECK(version=1))",
    `CREATE TABLE IF NOT EXISTS topics (${common}, name TEXT NOT NULL, name_key TEXT NOT NULL UNIQUE)`,
    `CREATE TABLE IF NOT EXISTS tasks (${common}, family_id ${id} NOT NULL REFERENCES tasks(id), version INTEGER NOT NULL CHECK(version>0), previous_task_id ${id} UNIQUE REFERENCES tasks(id), title TEXT NOT NULL, prompt TEXT NOT NULL, reference_answer TEXT, ${j("rubric", true)}, background TEXT, ${j("source", true)}, search_text TEXT NOT NULL, UNIQUE(family_id,version))`,
    `CREATE TABLE IF NOT EXISTS task_topics (task_id ${id} NOT NULL REFERENCES tasks(id), topic_id ${id} NOT NULL REFERENCES topics(id), PRIMARY KEY(task_id,topic_id))`,
    `CREATE TABLE IF NOT EXISTS trials (${common}, task_id ${id} NOT NULL REFERENCES tasks(id), occurred_at ${time}, answer TEXT NOT NULL, answer_kind TEXT NOT NULL CHECK(answer_kind IN ('verbatim','summary')), ${j("process")}, ${j("conditions")}, ${j("source", true)}, based_on_grade_id ${id}${dialect === "sqlite" ? " REFERENCES grades(id)" : ""}, supersedes_trial_id ${id} UNIQUE REFERENCES trials(id), correction_reason TEXT)`,
    `CREATE TABLE IF NOT EXISTS grades (${common}, trial_id ${id} NOT NULL REFERENCES trials(id), ${j("basis")}, feedback TEXT NOT NULL, ${j("findings")}, ${j("uncertainties")}, ${j("evaluator")}, supersedes_grade_id ${id} UNIQUE REFERENCES grades(id), correction_reason TEXT)`,
    "CREATE INDEX IF NOT EXISTS task_topics_reverse ON task_topics(topic_id,task_id)",
    "CREATE INDEX IF NOT EXISTS trials_task_order ON trials(task_id,created_at,id)",
    "CREATE INDEX IF NOT EXISTS trials_based_on ON trials(based_on_grade_id)",
    "CREATE INDEX IF NOT EXISTS grades_trial_order ON grades(trial_id,created_at,id)",
  ];
}

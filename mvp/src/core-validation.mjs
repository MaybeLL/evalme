import { createHash } from "node:crypto";
export class EvalmeError extends Error {
  constructor(code, message, details = {}, retryable = false) {
    super(message);
    this.name = "EvalmeError";
    this.code = code;
    this.details = details;
    this.retryable = retryable;
    this.exitCode =
      {
        VALIDATION_ERROR: 2,
        INVALID_CURSOR: 2,
        NOT_FOUND: 3,
        CONFLICT: 4,
        TOPIC_EXISTS: 4,
        IDEMPOTENCY_CONFLICT: 4,
        CONFIG_ERROR: 5,
        SCHEMA_SETUP_REQUIRED: 5,
        SCHEMA_INCOMPATIBLE: 5,
        DB_BUSY: 6,
        DB_CONNECTION_FAILED: 6,
        COMMIT_UNKNOWN: 6,
      }[code] ?? 1;
  }
}
export function fail(message) {
  throw new EvalmeError("VALIDATION_ERROR", message);
}
export function object(value, label = "input") {
  if (!value || typeof value !== "object" || Array.isArray(value))
    fail(`${label} must be an object`);
  return value;
}
export function fields(value, allowed, required = [], label = "input") {
  object(value, label);
  for (const key of Object.keys(value))
    if (!allowed.includes(key)) fail(`${label}: unknown field ${key}`);
  for (const key of required)
    if (!Object.hasOwn(value, key)) fail(`${label}: missing ${key}`);
}
export function text(value, label) {
  if (typeof value !== "string" || !value.trim())
    fail(`${label} must be nonempty text`);
  if (value.includes("\0")) fail(`${label} must not contain NUL`);
  if (!value.isWellFormed())
    fail(`${label} must contain valid Unicode scalar values`);
  return value;
}
export function optionalText(value, label) {
  return value == null ? null : text(value, label);
}
export function uuid(value, label = "id") {
  if (
    typeof value !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      value,
    )
  )
    fail(`${label} must be a UUID v4`);
  return value.toLowerCase();
}
const enumeration = (value, allowed, label) => {
  if (!allowed.includes(value)) fail(`${label} has unsupported value`);
  return value;
};
export const normalizeSearch = (value) =>
  value.normalize("NFKC").replace(/[A-Z]/g, (c) => c.toLowerCase());
export const topicKey = (value) =>
  normalizeSearch(value).trim().replace(/\s+/g, " ");
export function stable(value) {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.keys(value)
      .sort()
      .map((k) => JSON.stringify(k) + ":" + stable(value[k]))
      .join(",")}}`;
  return JSON.stringify(value);
}
export const hash = (value) =>
  createHash("sha256").update(stable(value)).digest("hex");
const texts = (value, label) => {
  if (!Array.isArray(value)) fail(`${label} must be an array`);
  return value.map((v) => text(v, label));
};
function source(value) {
  if (value == null) return null;
  fields(
    value,
    ["description", "ref", "excerpt_kind"],
    ["description"],
    "source",
  );
  const result = { description: text(value.description, "source.description") };
  if (value.ref !== undefined) result.ref = text(value.ref, "source.ref");
  if (value.excerpt_kind !== undefined)
    result.excerpt_kind = enumeration(
      value.excerpt_kind,
      ["verbatim", "summary"],
      "source.excerpt_kind",
    );
  return result;
}
function unique(values, label) {
  if (new Set(values).size !== values.length) fail(`${label} must be unique`);
}
const taskFields = [
  "id",
  "title",
  "prompt",
  "reference_answer",
  "rubric",
  "background",
  "source",
  "topic_ids",
];
export function normalize(kind, input) {
  object(input);
  let size;
  try {
    size = Buffer.byteLength(JSON.stringify(input));
  } catch {
    fail("input must be JSON");
  }
  if (size > 1048576) fail("input exceeds 1 MiB");
  const id = uuid(input.id);
  let n;
  if (kind === "topic") {
    fields(input, ["id", "name"], ["id", "name"]);
    n = { id, name: text(input.name, "name") };
  }
  if (kind === "task" || kind === "revision") {
    const revision = kind === "revision";
    fields(
      input,
      revision ? [...taskFields, "previous_task_id"] : taskFields,
      revision ? [...taskFields, "previous_task_id"] : ["id", "prompt"],
    );
    const prompt = text(input.prompt, "prompt");
    if (Buffer.byteLength(prompt) > 65536) fail("prompt exceeds 64 KiB");
    const title =
      input.title === undefined
        ? [
            ...prompt
              .split(/\r?\n/)
              .find((l) => l.trim())
              .trim(),
          ]
            .slice(0, 60)
            .join("")
        : text(input.title, "title");
    let rubric = input.rubric == null ? null : texts(input.rubric, "rubric");
    if (rubric?.length === 0) rubric = null;
    if (input.topic_ids !== undefined && !Array.isArray(input.topic_ids))
      fail("topic_ids must be an array");
    const topic_ids = (input.topic_ids ?? []).map((v) => uuid(v, "topic_ids"));
    unique(topic_ids, "topic_ids");
    n = {
      id,
      title,
      prompt,
      reference_answer: optionalText(
        input.reference_answer,
        "reference_answer",
      ),
      rubric,
      background: optionalText(input.background, "background"),
      source: source(input.source),
      topic_ids,
    };
    if (revision)
      n.previous_task_id = uuid(input.previous_task_id, "previous_task_id");
  }
  if (kind === "trial") {
    fields(
      input,
      [
        "id",
        "task_id",
        "occurred_at",
        "answer",
        "answer_kind",
        "process",
        "conditions",
        "source",
        "based_on_grade_id",
        "supersedes_trial_id",
        "correction_reason",
      ],
      ["id", "task_id", "answer", "answer_kind", "conditions"],
    );
    let occurred_at = null;
    if (input.occurred_at != null) {
      if (
        typeof input.occurred_at !== "string" ||
        !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:\d\d)$/.test(
          input.occurred_at,
        ) ||
        !Number.isFinite(Date.parse(input.occurred_at))
      )
        fail("occurred_at must be RFC3339 with timezone");
      const calendar = input.occurred_at.slice(0, 10);
      if (
        new Date(calendar + "T00:00:00Z").toISOString().slice(0, 10) !==
        calendar
      )
        fail("occurred_at has an invalid calendar date");
      occurred_at = new Date(input.occurred_at).toISOString();
    }
    const c = input.conditions;
    fields(
      c,
      ["hint_status", "hints", "context_note"],
      ["hint_status", "hints"],
      "conditions",
    );
    const hint_status = enumeration(
      c.hint_status,
      ["none", "provided", "unknown"],
      "hint_status",
    );
    const hints = texts(c.hints, "hints");
    const context_note = optionalText(c.context_note, "context_note");
    if (hint_status === "none" && hints.length)
      fail("none cannot include hints");
    if (hint_status === "provided" && !hints.length)
      fail("provided requires hints");
    if (hint_status === "unknown" && !context_note)
      fail("unknown requires context_note");
    if (input.process !== undefined && !Array.isArray(input.process))
      fail("process must be an array");
    const process = (input.process ?? []).map((p) => {
      fields(
        p,
        ["id", "role", "text", "kind"],
        ["id", "role", "text", "kind"],
        "process",
      );
      return {
        id: text(p.id, "process.id"),
        role: enumeration(p.role, ["user", "assistant"], "process.role"),
        text: text(p.text, "process.text"),
        kind: enumeration(p.kind, ["verbatim", "summary"], "process.kind"),
      };
    });
    unique(
      process.map((p) => p.id),
      "process IDs",
    );
    n = {
      id,
      task_id: uuid(input.task_id, "task_id"),
      occurred_at,
      answer: text(input.answer, "answer"),
      answer_kind: enumeration(
        input.answer_kind,
        ["verbatim", "summary"],
        "answer_kind",
      ),
      process,
      conditions: { hint_status, hints, context_note },
      source: source(input.source),
      based_on_grade_id:
        input.based_on_grade_id == null ? null : uuid(input.based_on_grade_id),
      supersedes_trial_id:
        input.supersedes_trial_id == null
          ? null
          : uuid(input.supersedes_trial_id),
      correction_reason: optionalText(
        input.correction_reason,
        "correction_reason",
      ),
    };
    if (Boolean(n.supersedes_trial_id) !== Boolean(n.correction_reason))
      fail("correction_reason and supersedes_trial_id must appear together");
  }
  if (kind === "grade") {
    fields(
      input,
      [
        "id",
        "trial_id",
        "basis",
        "feedback",
        "findings",
        "uncertainties",
        "evaluator",
        "supersedes_grade_id",
        "correction_reason",
      ],
      [
        "id",
        "trial_id",
        "basis",
        "feedback",
        "findings",
        "uncertainties",
        "evaluator",
      ],
    );
    fields(input.basis, ["mode", "reasoning"], ["mode", "reasoning"], "basis");
    const basis = {
      mode: enumeration(
        input.basis.mode,
        ["task_only", "task_rubric"],
        "basis.mode",
      ),
      reasoning: text(input.basis.reasoning, "basis.reasoning"),
    };
    if (!Array.isArray(input.findings) || !input.findings.length)
      fail("findings must be a nonempty array");
    const findings = input.findings.map((f) => {
      fields(
        f,
        ["id", "kind", "statement", "evidence", "next_focus"],
        ["id", "kind", "statement", "evidence"],
        "finding",
      );
      if (!Array.isArray(f.evidence)) fail("evidence must be an array");
      const evidence = f.evidence.map((e) => {
        fields(e, ["target", "quote"], ["target", "quote"], "evidence");
        return {
          target: text(e.target, "evidence.target"),
          quote: text(e.quote, "evidence.quote"),
        };
      });
      return {
        id: text(f.id, "finding.id"),
        kind: enumeration(
          f.kind,
          ["correct", "incorrect", "missing", "uncertain"],
          "finding.kind",
        ),
        statement: text(f.statement, "finding.statement"),
        evidence,
        ...(f.next_focus === undefined
          ? {}
          : { next_focus: text(f.next_focus, "next_focus") }),
      };
    });
    unique(
      findings.map((f) => f.id),
      "finding IDs",
    );
    fields(
      input.evaluator,
      ["name", "version", "model"],
      ["name"],
      "evaluator",
    );
    const evaluator = {
      name: text(input.evaluator.name, "evaluator.name"),
      version: optionalText(input.evaluator.version, "evaluator.version"),
    };
    if (input.evaluator.model !== undefined)
      evaluator.model = text(input.evaluator.model, "evaluator.model");
    n = {
      id,
      trial_id: uuid(input.trial_id, "trial_id"),
      basis,
      feedback: text(input.feedback, "feedback"),
      findings,
      uncertainties: texts(input.uncertainties, "uncertainties"),
      evaluator,
      supersedes_grade_id:
        input.supersedes_grade_id == null
          ? null
          : uuid(input.supersedes_grade_id),
      correction_reason: optionalText(
        input.correction_reason,
        "correction_reason",
      ),
    };
    if (Boolean(n.supersedes_grade_id) !== Boolean(n.correction_reason))
      fail("correction_reason and supersedes_grade_id must appear together");
  }
  if (!n) fail("unknown operation");
  return n;
}

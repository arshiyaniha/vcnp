'use strict';

/*
 * Envelope validation — lightweight approximation (plan §6.2 / protocol §3).
 *
 * HONEST NOTE: skills/core-protocol/references/envelope-schema.json is a full
 * JSON Schema (oneOf over taskBrief/resultReport, if/then, additionalProperties).
 * This validator implements targeted required-field/type/enum/minItems checks
 * against that schema's contracts; it does NOT implement general JSON-Schema
 * evaluation. It rejects everything the schema rejects for these fields, but
 * full spec compliance would require a JSON-Schema library (zero-dep constraint).
 */

const ENVELOPE_STATUSES = ['done', 'blocked', 'needs_input'];
const BOARD_STATUSES = ['todo', 'doing', 'awaiting_orchestrator', 'review', 'blocked', 'done'];
const TASK_CLASSES = ['C0', 'C1', 'C2', 'C3', 'C4'];
const LEDGER_SOURCES = ['provider_usage', 'ide_export', 'estimated'];

const SCHEMA_NOTE =
  'validation is a lightweight approximation of skills/core-protocol/references/envelope-schema.json ' +
  '(required fields / types / enums / minItems / the done->blockers if-then rule); full JSON-Schema ' +
  'evaluation is intentionally not implemented (zero-dependency constraint)';

/** Map a Result-Report status onto the board kanban status (protocol §3). */
function boardStatusForReportStatus(status) {
  if (status === 'done') return 'awaiting_orchestrator'; // written queue
  if (status === 'blocked' || status === 'needs_input') return 'blocked';
  return status;
}

/** Validate task_create input against the Task Brief contract. */
function validateTaskBriefInput(a) {
  const errs = [];
  if (typeof a.title !== 'string' || !a.title.trim()) {
    errs.push("'title' must be a non-empty string (envelope-schema.json #/taskBrief/properties/title, minLength: 1)");
  }
  if (!TASK_CLASSES.includes(a.task_class)) {
    errs.push(`'task_class' must be one of ${TASK_CLASSES.join('|')} (#/taskBrief/properties/taskClass enum)`);
  }
  if (
    !Array.isArray(a.acceptance_criteria) ||
    a.acceptance_criteria.length < 1 ||
    !a.acceptance_criteria.every((x) => typeof x === 'string' && x.trim())
  ) {
    errs.push("'acceptance_criteria' must be an array with at least 1 non-empty string (#/taskBrief/properties/acceptance_criteria, minItems: 1)");
  }
  if (!Number.isInteger(a.budget_tokens) || a.budget_tokens <= 0) {
    errs.push("'budget_tokens' must be an integer > 0 (#/taskBrief/properties/budget_tokens, type: integer, exclusiveMinimum: 0)");
  }
  if (a.assignee_role !== undefined && (typeof a.assignee_role !== 'string' || !a.assignee_role.trim())) {
    errs.push("'assignee_role' must be a non-empty string when provided");
  }
  if (a.priority !== undefined && !['low', 'medium', 'high', 'critical'].includes(a.priority)) {
    errs.push("'priority' must be one of low|medium|high|critical (#/taskBrief/properties/priority enum)");
  }
  if (a.context_refs !== undefined && !(Array.isArray(a.context_refs) && a.context_refs.every((x) => typeof x === 'string' && x))) {
    errs.push("'context_refs' must be an array of non-empty strings (#/taskBrief/properties/context_refs)");
  }
  if (a.definition_of_done !== undefined && (typeof a.definition_of_done !== 'string' || !a.definition_of_done.trim())) {
    errs.push("'definition_of_done' must be a non-empty string (#/taskBrief/properties/definition_of_done, minLength: 1)");
  }
  if (a.as_role !== undefined) {
    // Lazy require (not at module scope) to avoid a store.js <-> envelope.js
    // <-> tools/report.js load cycle — same pattern report.js itself uses
    // for live/work-core.js.
    const { ROLES } = require('../tools/report');
    if (typeof a.as_role !== 'string' || !ROLES.includes(a.as_role)) {
      errs.push(`'as_role' must be one of ${ROLES.join('|')} when provided`);
    }
  }
  return errs;
}

/**
 * Validate a Result-Report-shaped task_update patch against the resultReport
 * contract. Unknown keys are rejected (additionalProperties: false).
 */
function validateResultReportPatch(patch) {
  const errs = [];
  // as_role is a live-office extension (honest ledger attribution, task_update
  // is used both for Executor Result Reports and Orchestrator queue-draining)
  // — not part of the envelope-schema.json resultReport contract itself, but
  // allowed here rather than rejected as an unknown field.
  const allowed = ['status', 'progress_percent', 'artifacts', 'blockers', 'notes_for_qa', 'board_status', 'as_role'];
  for (const k of Object.keys(patch)) {
    if (!allowed.includes(k)) {
      errs.push(`'${k}' is not allowed in a Result Report update (envelope-schema.json #/resultReport, additionalProperties: false)`);
    }
  }
  if (patch.as_role !== undefined) {
    const { ROLES } = require('../tools/report');
    if (typeof patch.as_role !== 'string' || !ROLES.includes(patch.as_role)) {
      errs.push(`'as_role' must be one of ${ROLES.join('|')} when provided`);
    }
  }
  if (patch.status !== undefined && !ENVELOPE_STATUSES.includes(patch.status) && !BOARD_STATUSES.includes(patch.status)) {
    errs.push(`'status' must be one of ${ENVELOPE_STATUSES.join('|')} (Result Report) or a board status ${BOARD_STATUSES.join('|')} (#/resultReport/properties/status enum)`);
  }
  if (patch.progress_percent !== undefined && (!Number.isInteger(patch.progress_percent) || patch.progress_percent < 0 || patch.progress_percent > 100)) {
    errs.push("'progress_percent' must be an integer between 0 and 100 (#/resultReport/properties/progress_percent, minimum: 0, maximum: 100)");
  }
  if (patch.artifacts !== undefined && !(Array.isArray(patch.artifacts) && patch.artifacts.every((x) => typeof x === 'string' && x))) {
    errs.push("'artifacts' must be an array of non-empty strings (#/resultReport/properties/artifacts)");
  }
  if (patch.blockers !== undefined && !(Array.isArray(patch.blockers) && patch.blockers.every((x) => typeof x === 'string'))) {
    errs.push("'blockers' must be an array of strings (#/resultReport/properties/blockers)");
  }
  if (patch.notes_for_qa !== undefined && typeof patch.notes_for_qa !== 'string') {
    errs.push("'notes_for_qa' must be a string (#/resultReport/properties/notes_for_qa)");
  }
  if (patch.board_status !== undefined && !BOARD_STATUSES.includes(patch.board_status)) {
    errs.push(`'board_status' must be one of ${BOARD_STATUSES.join('|')} (board management vocabulary)`);
  }
  if (patch.status === 'done' && Array.isArray(patch.blockers) && patch.blockers.length > 0) {
    errs.push("'blockers' must be EMPTY when status='done' (envelope-schema.json #/resultReport if/then: status done -> blockers maxItems: 0)");
  }
  return errs;
}

module.exports = {
  ENVELOPE_STATUSES,
  BOARD_STATUSES,
  TASK_CLASSES,
  LEDGER_SOURCES,
  SCHEMA_NOTE,
  boardStatusForReportStatus,
  validateTaskBriefInput,
  validateResultReportPatch,
};

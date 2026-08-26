'use strict';

/*
 * events-validate.js — pure validators for the live-office ledger event
 * schemas (live-office plan §2). Phase 3 scope: message_posted /
 * message_answered. Phase 4 scope: work_logged / meeting_started /
 * meeting_ended. Unit-tested by test/events-validate.test.js.
 *
 * Ledger events stay OPEN (no additionalProperties:false contract — that
 * strictness is for Task Brief / Result Report envelopes only, plan §2), but
 * the shapes of these actions are FIXED here so renderers, MCP tools and
 * tests can rely on them. Every dedicated write path (inbox-core.postMessage,
 * inbox-core.replyMessage, work-core.*) validates through these helpers and
 * rejects invalid shapes exactly like any other domain op.
 *
 * Pure functions: no I/O, no store import. ROLES come from tools/report.js
 * (the single role registry per plan §2); importing it here is cycle-free
 * (report → store → lib/{ledger-engine,envelope,lock}). Workspace-relative
 * containment of artifact_refs is checked PURELY here (no absolute paths,
 * no '..' segments); the write ops additionally re-resolve against the real
 * workspace root as defense in depth.
 */

const { ROLES } = require('../tools/report');

const TEXT_MAX_POSTED = 2000;  // plan §1.3/§2: text 1..2000 chars on message_posted
const TEXT_MAX_ANSWERED = 4000; // plan §2: text 1..4000 chars on message_answered
const CHANNELS = ['web', 'cli', 'phone']; // plan §2 channel enum
const CALL_ID_RE = /^ph-\d{4}$/; // ph-NNNN, allocated under the office lock (plan §2)
/* plan §2 pins audio_ref to office/phone/<file>.webm (Chrome reference browser).
 * Edge/Safari fall back to audio/mp4|ogg containers (§6.2 preference chain); those
 * are stored under their REAL extension so playback Content-Type stays honest —
 * hence the small superset here. Server-generated names only: stamp + counter. */
const AUDIO_REF_RE = /^office\/phone\/([A-Za-z0-9][A-Za-z0-9_-]*)\.(webm|mp4|ogg)$/;
const MIME_RE = /^audio\/(webm|mp4|ogg)(;codecs=[A-Za-z0-9,._\- ]+)?$/i;
const LANG_DEFAULT = 'fa-IR'; // plan §2: lang:"fa-IR" (CLI --lang may pick another tag)
const LANG_RE = /^[a-zA-Z]{2,3}(-[A-Za-z0-9]{2,8})*$/;
/* The transcript becomes the paired message_posted text verbatim (§6.3), so it
 * inherits the message cap — a longer transcript could never be delivered. */
const TRANSCRIPT_MAX = TEXT_MAX_POSTED;
const MESSAGE_ID_RE = /^m-\d{4}$/; // m-NNNN, allocated under the office lock

/* ---- Phase 4 (plan §2): work_logged / meeting_started / meeting_ended ---- */
const WORK_SUMMARY_MAX = 300;   // action_summary:string(1..300)
const TOPIC_MAX = 200;          // meeting_started topic:string<=200
const OUTCOME_MAX = 300;        // meeting_ended outcome_summary:string<=300
const TASK_ID_RE = /^T-\d{3,4}$/;      // nextTaskId allocates T-NNN (engine)
const MEETING_ID_RE = /^mt-\d{4}$/;    // mt-NNNN, allocated under the office lock
const MEETING_REASONS = ['qa_gate', 'critical_task', 'standup', 'phone', 'explicit'];
const PARTICIPANTS_MIN = 2;     // participants:ROLES[] (2..9)
const PARTICIPANTS_MAX = 9;
const CODE_REF_LINES_MAX = 100000; // sanity cap for code_ref line numbers

function isNonEmptyString(v) {
  return typeof v === 'string' && v.trim().length > 0;
}

function knownRole(role) {
  return typeof role === 'string' && ROLES.includes(role);
}

/**
 * message_posted (plan §2): actor 'user' + exact fields
 *   message_id:m-NNNN · to_role:ROLES · text:1..2000 · channel:web|cli|phone
 * `message_id`/`actor` are allocated by the caller under the lock, so the
 * validator checks the user-supplied surface: to_role, text, channel.
 */
function validateMessagePosted(input) {
  const reasons = [];
  if (!input || typeof input !== 'object') return ["'input' must be an object"];
  if (!knownRole(input.to_role)) {
    reasons.push(`'to_role' must be one of ${ROLES.join('|')}`);
  }
  if (!isNonEmptyString(input.text)) {
    reasons.push("'text' must be a non-empty string");
  } else if (input.text.length > TEXT_MAX_POSTED) {
    reasons.push(`'text' must be at most ${TEXT_MAX_POSTED} characters (got ${input.text.length})`);
  }
  const channel = input.channel === undefined ? 'web' : input.channel;
  if (!CHANNELS.includes(channel)) {
    reasons.push(`'channel' must be one of ${CHANNELS.join('|')}`);
  }
  return reasons;
}

/**
 * message_answered (plan §2): actor <answering role> + exact fields
 *   message_id:<target m-NNNN> · reply_to:<event_id of message_posted> ·
 *   text:1..4000. The answering role is checked by the caller (as_role).
 */
function validateMessageAnswered(input) {
  const reasons = [];
  if (!input || typeof input !== 'object') return ["'input' must be an object"];
  if (!isNonEmptyString(input.reply_to)) {
    reasons.push("'reply_to' must be the event_id of the message_posted being answered");
  }
  if (input.message_id !== undefined && !MESSAGE_ID_RE.test(String(input.message_id))) {
    reasons.push("'message_id' must match m-NNNN");
  }
  if (!isNonEmptyString(input.text)) {
    reasons.push("'text' must be a non-empty string");
  } else if (input.text.length > TEXT_MAX_ANSWERED) {
    reasons.push(`'text' must be at most ${TEXT_MAX_ANSWERED} characters (got ${input.text.length})`);
  }
  return reasons;
}

/** Answering role must be a real office role (defaults to ceo upstream). */
function validateAnsweringRole(role) {
  return knownRole(role) ? [] : [`'as_role' must be one of ${ROLES.join('|')}`];
}

/* ---------------- Phase 4 helpers (plan §2) ---------------- */

/**
 * Workspace-relative path check, PURE: rejects absolute paths (leading '/',
 * leading '\\', drive letters like 'C:', UNC '\\\\server'), empty strings,
 * and any '..' segment (directory traversal). Backslashes are normalized for
 * the segment scan so 'src\\..\\secret' is caught on every platform.
 */
function validRelativeRef(ref) {
  if (typeof ref !== 'string') return false;
  const s = ref.trim();
  if (!s || s.length > 512) return false;
  if (/^[a-zA-Z]:/.test(s)) return false;      // drive letter (Windows)
  if (/^\/\/|^\\\\/.test(s)) return false;     // UNC / protocol-ish
  if (s.startsWith('/') || s.startsWith('\\')) return false; // absolute
  const segments = s.replace(/\\/g, '/').split('/');
  return segments.every((seg) => seg !== '..' && seg !== '');
}

/**
 * artifact_refs:string[] — workspace-relative paths (plan §2 work_logged).
 * Optional field: undefined passes (caller defaults to []); anything present
 * must be an array of valid relative refs. Duplicates are tolerated here and
 * deduped by projections (§7.1).
 */
function validateArtifactRefs(refs, field) {
  const name = field || "'artifact_refs'";
  if (refs === undefined) return [];
  if (!Array.isArray(refs)) return [`${name} must be an array of workspace-relative paths`];
  const reasons = [];
  refs.forEach((ref, i) => {
    if (!validRelativeRef(ref)) {
      reasons.push(`${name}[${i}] must be a non-empty workspace-relative path without '..' (got ${JSON.stringify(ref)})`);
    }
  });
  return reasons;
}

/**
 * code_ref?:{path, lines:[from,to]} — optional pointer to real source lines.
 * NO file content is ever carried or validated here (no fabricated code):
 * only the shape of the POINTER is checked.
 */
function validateCodeRef(codeRef) {
  if (codeRef === undefined) return [];
  const reasons = [];
  if (!codeRef || typeof codeRef !== 'object' || Array.isArray(codeRef)) {
    return ["'code_ref' must be an object {path, lines:[from,to]}"];
  }
  if (!validRelativeRef(codeRef.path)) {
    reasons.push("'code_ref.path' must be a non-empty workspace-relative path without '..'");
  }
  const L = codeRef.lines;
  if (!Array.isArray(L) || L.length !== 2 ||
      !Number.isInteger(L[0]) || !Number.isInteger(L[1]) ||
      L[0] < 1 || L[1] < L[0] || L[1] > CODE_REF_LINES_MAX) {
    reasons.push("'code_ref.lines' must be [from,to] integers with 1 <= from <= to");
  }
  return reasons;
}

/**
 * work_logged (plan §2): actor = any known role (checked by caller via
 * validateActorRole); fields:
 *   task_id?:string(T-NNN) · action_summary:string(1..300) ·
 *   artifact_refs?:string[](workspace-relative) · code_ref?:{path,lines}
 */
function validateWorkLogged(input) {
  const reasons = [];
  if (!input || typeof input !== 'object') return ["'input' must be an object"];
  if (input.task_id !== undefined && !TASK_ID_RE.test(String(input.task_id))) {
    reasons.push("'task_id' must match T-NNN");
  }
  if (!isNonEmptyString(input.action_summary)) {
    reasons.push("'action_summary' must be a non-empty string");
  } else if (input.action_summary.length > WORK_SUMMARY_MAX) {
    reasons.push(`'action_summary' must be at most ${WORK_SUMMARY_MAX} characters (got ${input.action_summary.length})`);
  }
  reasons.push(...validateArtifactRefs(input.artifact_refs));
  reasons.push(...validateCodeRef(input.code_ref));
  return reasons;
}

/**
 * meeting_started (plan §2): actor = orchestrator or triggering role;
 * fields: meeting_id:string(mt-NNNN, allocated under lock by caller) ·
 * reason enum · participants:ROLES[] (2..9 distinct) · task_id? · topic<=200.
 */
function validateMeetingStarted(input) {
  const reasons = [];
  if (!input || typeof input !== 'object') return ["'input' must be an object"];
  if (!MEETING_REASONS.includes(input.reason)) {
    reasons.push(`'reason' must be one of ${MEETING_REASONS.join('|')}`);
  }
  const P = input.participants;
  if (!Array.isArray(P)) {
    reasons.push("'participants' must be an array of 2..9 office roles");
  } else {
    if (P.length < PARTICIPANTS_MIN || P.length > PARTICIPANTS_MAX) {
      reasons.push(`'participants' must hold between ${PARTICIPANTS_MIN} and ${PARTICIPANTS_MAX} roles (got ${P.length})`);
    }
    P.forEach((role, i) => {
      if (!knownRole(role)) reasons.push(`'participants[${i}]' must be one of ${ROLES.join('|')} (got ${JSON.stringify(role)})`);
    });
    if (new Set(P).size !== P.length) reasons.push("'participants' must not repeat a role");
  }
  if (!isNonEmptyString(input.topic)) {
    reasons.push("'topic' must be a non-empty string");
  } else if (input.topic.length > TOPIC_MAX) {
    reasons.push(`'topic' must be at most ${TOPIC_MAX} characters (got ${input.topic.length})`);
  }
  if (input.task_id !== undefined && !TASK_ID_RE.test(String(input.task_id))) {
    reasons.push("'task_id' must match T-NNN");
  }
  return reasons;
}

/**
 * meeting_ended (plan §2): actor = SAME actor as the matching start (the
 * write op enforces that under the lock); fields: meeting_id:string(mt-NNNN)
 * · outcome_summary?:string<=300 (optional-but-capped: honest quick ends are
 * allowed, fabrication-free).
 */
function validateMeetingEnded(input) {
  const reasons = [];
  if (!input || typeof input !== 'object') return ["'input' must be an object"];
  if (!isNonEmptyString(input.meeting_id)) {
    reasons.push("'meeting_id' must be the mt-NNNN id of the meeting being ended");
  } else if (!MEETING_ID_RE.test(input.meeting_id)) {
    reasons.push("'meeting_id' must match mt-NNNN");
  }
  if (input.outcome_summary !== undefined && input.outcome_summary !== null) {
    if (!isNonEmptyString(input.outcome_summary)) {
      reasons.push("'outcome_summary' must be a non-empty string when provided");
    } else if (input.outcome_summary.length > OUTCOME_MAX) {
      reasons.push(`'outcome_summary' must be at most ${OUTCOME_MAX} characters (got ${input.outcome_summary.length})`);
    }
  }
  return reasons;
}

/**
 * phone_call_received (plan §2/§6, Phase 5): actor 'user' + exact fields
 *   call_id:ph-NNNN (allocated under lock by caller) · transcript:string|null ·
 *   audio_ref:"office/phone/<name>.<ext>" · mime:audio/webm|mp4|ogg[;codecs=…] ·
 *   duration_ms:int>=0 · lang (default fa-IR) · has_transcript:bool ·
 *   paired_message_id:m-NNNN.
 * HONESTY: transcript null ⇔ has_transcript false — a missing transcript is
 * carried as an explicit marker, never fabricated (plan §6.2/R8).
 * `audio_base64` is transport-only (D5) and deliberately NOT part of the
 * ledger event shape; size caps live in live/phone-core.js.
 */
function validatePhoneCallReceived(input) {
  const reasons = [];
  if (!input || typeof input !== 'object') return ["'input' must be an object"];
  if (input.call_id !== undefined && !CALL_ID_RE.test(String(input.call_id))) {
    reasons.push("'call_id' must match ph-NNNN");
  }
  if (input.transcript !== undefined && input.transcript !== null) {
    if (typeof input.transcript !== 'string' || input.transcript.trim().length === 0) {
      reasons.push("'transcript' must be a non-empty string or null");
    } else if (input.transcript.length > TRANSCRIPT_MAX) {
      reasons.push(`'transcript' must be at most ${TRANSCRIPT_MAX} characters (got ${input.transcript.length})`);
    }
  }
  if (typeof input.audio_ref !== 'string' || !AUDIO_REF_RE.test(input.audio_ref)) {
    reasons.push(`'audio_ref' must match office/phone/<name>.(webm|mp4|ogg) (got ${JSON.stringify(input.audio_ref)})`);
  }
  if (typeof input.mime !== 'string' || !MIME_RE.test(input.mime)) {
    reasons.push("'mime' must be audio/webm, audio/mp4 or audio/ogg (optional ;codecs=…)");
  }
  if (!Number.isInteger(input.duration_ms) || input.duration_ms < 0) {
    reasons.push("'duration_ms' must be an integer >= 0");
  }
  const lang = input.lang === undefined ? LANG_DEFAULT : input.lang;
  if (typeof lang !== 'string' || !LANG_RE.test(lang)) {
    reasons.push("'lang' must be a BCP-47 tag such as fa-IR");
  }
  if (typeof input.has_transcript !== 'boolean') {
    reasons.push("'has_transcript' must be a boolean");
  } else {
    const really = typeof input.transcript === 'string' && input.transcript.trim().length > 0;
    if (input.has_transcript !== really) {
      reasons.push("'has_transcript' must equal whether a non-empty transcript is present");
    }
  }
  if (typeof input.paired_message_id !== 'string' || !MESSAGE_ID_RE.test(input.paired_message_id)) {
    reasons.push("'paired_message_id' must match m-NNNN");
  }
  return reasons;
}

module.exports = {
  ROLES,
  CHANNELS,
  TEXT_MAX_POSTED,
  TEXT_MAX_ANSWERED,
  MESSAGE_ID_RE,
  TASK_ID_RE,
  MEETING_ID_RE,
  MEETING_REASONS,
  PARTICIPANTS_MIN,
  PARTICIPANTS_MAX,
  WORK_SUMMARY_MAX,
  TOPIC_MAX,
  OUTCOME_MAX,
  CALL_ID_RE,
  AUDIO_REF_RE,
  MIME_RE,
  LANG_DEFAULT,
  LANG_RE,
  TRANSCRIPT_MAX,
  validateMessagePosted,
  validateMessageAnswered,
  validateAnsweringRole,
  validateActorRole: validateAnsweringRole, // generic alias for non-inbox write ops
  validateArtifactRefs,
  validateCodeRef,
  validateWorkLogged,
  validateMeetingStarted,
  validateMeetingEnded,
  validatePhoneCallReceived,
};

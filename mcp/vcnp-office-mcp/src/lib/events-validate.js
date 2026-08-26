'use strict';

/*
 * events-validate.js — pure validators for the live-office ledger event
 * schemas (live-office plan §2, Phase 3 scope: message_posted /
 * message_answered). Unit-tested by test/events-validate.test.js.
 *
 * Ledger events stay OPEN (no additionalProperties:false contract — that
 * strictness is for Task Brief / Result Report envelopes only, plan §2), but
 * the shapes of the chat actions are FIXED here so renderers, MCP tools and
 * tests can rely on them. Every dedicated write path (inbox-core.postMessage,
 * inbox-core.replyMessage) validates through these helpers and rejects invalid
 * shapes exactly like any other domain op.
 *
 * Pure functions: no I/O, no store import. ROLES come from tools/report.js
 * (the single role registry per plan §2); importing it here is cycle-free
 * (report → store → lib/{ledger-engine,envelope,lock}).
 */

const { ROLES } = require('../tools/report');

const TEXT_MAX_POSTED = 2000;  // plan §1.3/§2: text 1..2000 chars on message_posted
const TEXT_MAX_ANSWERED = 4000; // plan §2: text 1..4000 chars on message_answered
const CHANNELS = ['web', 'cli', 'phone']; // plan §2 channel enum
const MESSAGE_ID_RE = /^m-\d{4}$/; // m-NNNN, allocated under the office lock

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

module.exports = {
  ROLES,
  CHANNELS,
  TEXT_MAX_POSTED,
  TEXT_MAX_ANSWERED,
  MESSAGE_ID_RE,
  validateMessagePosted,
  validateMessageAnswered,
  validateAnsweringRole,
};

#!/usr/bin/env node
'use strict';

/*
 * tools/phone-drop.js — CLI intake for the VCNP telephone exchange
 * «تلفنخانه» (live-office plan §6.4, Phase 5).
 *
 * Commands typed inside a VCNP session enter the SAME queue as browser calls:
 * this script goes through live/inbox-core.postMessage and live/phone-core.
 * receiveCall — the exact code paths behind POST /api/message and
 * POST /api/phone — so identical ledger events, sidecars and mirror/SSE
 * refreshes come out the other end (plan §6.4 "identical downstream behavior").
 *
 * Usage (zero dependencies, Windows-safe paths):
 *   node tools/phone-drop.js --text "لطفا وضعیت را بگو" [--to ceo]
 *   node tools/phone-drop.js "متن پیام"                       (positional text)
 *   node tools/phone-drop.js --audio C:\tmp\note.webm [--transcript "..."]
 *                            [--lang fa-IR] [--to ceo]
 *
 * Text mode  → one message_posted {channel:"cli"} event (plan §2).
 * Audio mode → office/phone/<stamp>.<ext> + sidecar json + the PAIRED pair
 *              phone_call_received + message_posted {channel:"phone"} (§6.3).
 *
 * Output: one JSON line on stdout; exit 0 = accepted, 1 = rejected honestly.
 * Diagnostics go to stderr only.
 */

const fs = require('fs');
const path = require('path');

const MCP_SRC = path.resolve(__dirname, '..', 'mcp', 'vcnp-office-mcp', 'src');

function load(rel) {
  return require(path.join(MCP_SRC, rel));
}

function usage(code) {
  process.stderr.write(
    'usage: node tools/phone-drop.js --text "متن" [--to ceo]\n' +
    '       node tools/phone-drop.js "متن پیام"\n' +
    '       node tools/phone-drop.js --audio <file.webm|mp4|ogg|wav> [--transcript "..."] ' +
    '[--lang fa-IR] [--to ceo]\n'
  );
  process.exit(code);
}

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') usage(0);
    let key = null;
    let val = null;
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      if (eq > 2) {
        key = a.slice(2, eq);
        val = a.slice(eq + 1);
      } else {
        key = a.slice(2);
        val = argv[i + 1];
        if (val !== undefined && !val.startsWith('--')) i += 1;
        else val = '';
      }
    } else {
      out._.push(a);
      continue;
    }
    out[key] = val;
  }
  return out;
}

(async () => {
  const args = parseArgs(process.argv.slice(2));
  const to = args.to && String(args.to).trim() ? String(args.to).trim() : 'ceo';
  const lang = args.lang && String(args.lang).trim() ? String(args.lang).trim() : undefined;

  /* ---- audio mode: identical path to POST /api/phone ---- */
  if (args.audio !== undefined) {
    const file = path.resolve(String(args.audio || '').trim());
    let buf;
    try {
      buf = fs.readFileSync(file);
    } catch (err) {
      process.stderr.write(`cannot read audio file '${file}': ${(err && err.message) || err}\n`);
      process.exit(1);
    }
    const container = load('live/phone-core').sniffContainer(buf);
    const mime = container ? `audio/${container}` : 'audio/webm'; // receiveCall re-sniffs honestly
    const r = await load('live/phone-core').receiveCall({
      audio_base64: buf.toString('base64'),
      mime,
      transcript: args.transcript !== undefined && String(args.transcript).trim()
        ? String(args.transcript)
        : null,
      lang,
      duration_ms: args.duration_ms !== undefined ? Number(args.duration_ms) : 0,
      to_role: to,
      source: 'cli',
      ip: 'cli',
    });
    process.stdout.write(JSON.stringify(r) + '\n');
    process.exit(r && r.ok ? 0 : 1);
  }

  /* ---- text mode: identical path to POST /api/message (channel cli) ---- */
  const text = args.text !== undefined ? String(args.text) : (args._[0] !== undefined ? String(args._[0]) : '');
  if (!text.trim()) {
    process.stderr.write('nothing to drop: pass --text "…" or a positional message\n');
    usage(1);
  }
  if (args.from !== undefined && String(args.from) !== 'user') {
    process.stderr.write("'--from' supports only 'user' — plan §2 fixes the message_posted actor\n");
    process.exit(1);
  }
  const r = await load('live/inbox-core').postMessage({ to_role: to, text, channel: 'cli' });
  process.stdout.write(JSON.stringify(r) + '\n');
  process.exit(r && r.ok ? 0 : 1);
})().catch((err) => {
  process.stderr.write(`phone-drop failed: ${(err && err.stack) || err}\n`);
  process.exit(1);
});

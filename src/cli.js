#!/usr/bin/env node
/**
 * Headless sender, for when you'd rather not open the UI.
 *
 *   node src/cli.js --to "a@x.com, b@y.com" --template templates/default.md --dry-run
 *   node src/cli.js --to-file list.csv --template templates/default.md --attach Ricardo-McPherson-CV-ATS.pdf --send
 *
 * Dry run is the default. You must pass --send to actually deliver anything.
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';

import { parseRecipients } from './lib/recipients.js';
import { sendCampaign, planCampaign } from './lib/mailer.js';
import { smtpConfigured } from './lib/config.js';

function parseArgs(argv) {
  const args = { attach: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    const next = () => argv[++i];
    switch (a) {
      case '--to': args.to = next(); break;
      case '--to-file': args.toFile = next(); break;
      case '--template': args.template = next(); break;
      case '--subject': args.subject = next(); break;
      case '--attach': args.attach.push(next()); break;
      case '--role': args.role = next(); break;
      case '--batch': args.batchCap = Number(next()); break;
      case '--delay': args.delayMs = Number(next()); break;
      case '--send': args.send = true; break;
      case '--dry-run': args.send = false; break;
      case '--allow-resend': args.allowResend = true; break;
      case '-h': case '--help': args.help = true; break;
      default:
        if (a.startsWith('--')) throw new Error(`Unknown flag: ${a}`);
    }
  }
  return args;
}

const HELP = `
Resume Mailer CLI

  --to "<list>"        Recipients: comma, space, semicolon or newline separated.
                       Rich form per line: email | Company | Hiring Manager | Role
  --to-file <path>     Read the recipient list from a file (.txt or .csv with header).
  --template <path>    Markdown-ish file: first line "Subject: ...", blank line, then body.
  --subject "<text>"   Override the subject line.
  --attach <filename>  File inside attachments/ (repeatable).
  --role "<text>"      Default {{role}} when a recipient has none.
  --batch <n>          Max messages this run.
  --delay <ms>         Base gap between messages.
  --allow-resend       Permit contacting addresses already in the send log.
  --send               Actually send. Without this you get a dry run.
`;

async function loadTemplate(file) {
  const raw = await fs.readFile(file, 'utf8');
  const m = /^subject:\s*(.+)\n/i.exec(raw);
  if (!m) return { subject: null, body: raw.trim() };
  return { subject: m[1].trim(), body: raw.slice(m[0].length).trim() };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || (!args.to && !args.toFile)) { console.log(HELP); process.exit(args.help ? 0 : 1); }

  const rawList = args.toFile ? await fs.readFile(path.resolve(args.toFile), 'utf8') : args.to;
  const { recipients, errors, duplicates } = parseRecipients(rawList);

  if (errors.length) {
    console.error(`\n  ${errors.length} entr${errors.length === 1 ? 'y' : 'ies'} could not be parsed:`);
    for (const e of errors) console.error(`    - ${e.value}: ${e.reason}`);
  }
  if (duplicates.length) console.log(`\n  Ignored ${duplicates.length} duplicate address(es).`);
  if (!recipients.length) { console.error('\n  No valid recipients.\n'); process.exit(1); }

  let subject = args.subject;
  let body;
  if (args.template) {
    const t = await loadTemplate(path.resolve(args.template));
    subject = subject || t.subject;
    body = t.body;
  }
  if (!subject || !body) { console.error('\n  A --template (and/or --subject) is required.\n'); process.exit(1); }

  const dryRun = !args.send;
  if (!dryRun && !smtpConfigured()) {
    console.error('\n  SMTP is not configured. Copy .env.example to .env first.\n');
    process.exit(1);
  }

  const plan = await planCampaign(recipients, { allowResend: args.allowResend });
  console.log(`\n  ${recipients.length} parsed | ${plan.queued.length} queued | ${plan.skipped.length} skipped`);
  for (const s of plan.skipped) console.log(`    skip ${s.email} - ${s.reason}`);
  console.log(`  ${plan.sentToday}/${plan.dailyCap} sent in the last 24h\n`);

  if (dryRun) console.log('  DRY RUN - nothing will be delivered. Add --send to go live.\n');

  const summary = await sendCampaign(recipients, {
    subject,
    body,
    attachments: args.attach,
    dryRun,
    allowResend: args.allowResend,
    batchCap: args.batchCap,
    delayMs: args.delayMs,
    defaultRole: args.role,
  }, (ev) => {
    if (ev.type === 'sent') console.log(`  -> ${ev.email}  [${ev.status}]  ${ev.subject}`);
    if (ev.type === 'failed') console.log(`  !! ${ev.email}  ${ev.error}`);
    if (ev.type === 'waiting') process.stdout.write(`     waiting ${(ev.ms / 1000).toFixed(1)}s\r`);
  });

  console.log(`\n  Done. sent=${summary.sent} dryRun=${summary.dryRun} failed=${summary.failed} skipped=${summary.skipped.length}\n`);

  if (dryRun && recipients[0]) {
    const { composeMessage } = await import('./lib/mailer.js');
    const m = composeMessage(recipients[0], { subject, body, defaultRole: args.role });
    console.log('  --- how the first message will read ---\n');
    console.log(`  To:      ${m.to}`);
    console.log(`  Subject: ${m.subject}\n`);
    console.log(m.text.split('\n').map((l) => `  | ${l}`).join('\n'));
    console.log('');
  }
}

main().catch((err) => { console.error(`\n  ${err.message}\n`); process.exit(1); });

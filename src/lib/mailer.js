/**
 * Campaign execution: render, guard, throttle, send, log.
 *
 * Every guard here exists to prevent a specific bad outcome:
 *  - suppression + already-sent checks  -> never email the same person twice
 *  - daily cap                          -> stay under provider limits
 *  - dry run                            -> see exactly what goes out first
 *  - per-recipient try/catch            -> one bad address cannot kill the run
 */

import nodemailer from 'nodemailer';
import { promises as fs } from 'node:fs';
import path from 'node:path';

import { config } from './config.js';
import { buildVars, render, textToHtml } from './template.js';
import * as store from './store.js';

let transporter = null;

export function getTransport() {
  if (transporter) return transporter;
  const { host, port, secure, user, pass } = config.smtp;
  if (!host || !user || !pass) {
    throw new Error('SMTP is not configured. Set SMTP_HOST, SMTP_USER and SMTP_PASS in .env');
  }
  transporter = nodemailer.createTransport({
    host,
    port,
    secure,
    auth: { user, pass },
    pool: true,
    maxConnections: 1,
    maxMessages: 50,
  });
  return transporter;
}

export async function verifyTransport() {
  const t = getTransport();
  await t.verify();
  return true;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function resolveAttachments(names = []) {
  const out = [];
  for (const name of names) {
    // Basename only: never let a campaign payload reach outside the attachments dir.
    const safe = path.basename(String(name));
    const full = path.join(config.attachmentsDir, safe);
    try {
      const st = await fs.stat(full);
      if (!st.isFile()) continue;
      out.push({ filename: safe, path: full, size: st.size });
    } catch {
      throw new Error(`Attachment not found: ${safe} (looked in ${config.attachmentsDir})`);
    }
  }
  return out;
}

export async function listAttachments() {
  try {
    const entries = await fs.readdir(config.attachmentsDir, { withFileTypes: true });
    const files = [];
    for (const e of entries) {
      if (!e.isFile() || e.name.startsWith('.')) continue;
      const st = await fs.stat(path.join(config.attachmentsDir, e.name));
      files.push({ name: e.name, size: st.size });
    }
    return files.sort((a, b) => a.name.localeCompare(b.name));
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
}

/**
 * Render one message without sending. Also used by the preview endpoint, so what
 * you see in the UI is byte-for-byte what the send path produces.
 */
export function composeMessage(recipient, campaign, settings = config) {
  const vars = buildVars(recipient, {
    ...settings.me,
    fallbackGreeting: campaign.fallbackGreeting || settings.fallbackGreeting,
    defaultRole: campaign.defaultRole || settings.defaultRole,
  });

  const subject = render(campaign.subject, vars, { strict: true });
  const text = render(campaign.body, vars, { strict: true });

  return {
    to: recipient.email,
    subject,
    text,
    html: textToHtml(text),
    vars,
  };
}

/**
 * Screen a recipient list against the suppression list, the send log and the
 * daily cap. Returns what would be sent and what would be skipped, and why.
 */
export async function planCampaign(recipients, campaign = {}) {
  const suppression = new Set((await store.getSuppression()).map((s) => s.email.toLowerCase()));
  const sent = await store.sentIndex();
  const sentToday = await store.sentWithin(24);

  const cap = campaign.dailyCap ?? config.throttle.dailyCap;
  const remaining = Math.max(0, cap - sentToday);

  const queued = [];
  const skipped = [];

  for (const r of recipients) {
    const email = r.email.toLowerCase();

    if (suppression.has(email)) {
      skipped.push({ ...r, reason: 'on suppression list' });
      continue;
    }
    if (!campaign.allowResend && sent.has(email)) {
      const prev = sent.get(email);
      skipped.push({ ...r, reason: `already emailed ${new Date(prev.at).toLocaleDateString()}` });
      continue;
    }
    if (queued.length >= remaining) {
      skipped.push({ ...r, reason: `daily cap reached (${cap}/24h)` });
      continue;
    }
    queued.push(r);
  }

  return { queued, skipped, sentToday, dailyCap: cap, remaining };
}

/**
 * Run a campaign.
 * @param {Array} recipients
 * @param {{subject:string, body:string, attachments?:string[], dryRun?:boolean}} campaign
 * @param {(ev:object)=>void} onProgress
 */
export async function sendCampaign(recipients, campaign, onProgress = () => {}) {
  const dryRun = Boolean(campaign.dryRun);
  const attachments = await resolveAttachments(campaign.attachments || []);
  const { queued, skipped, remaining, dailyCap } = await planCampaign(recipients, campaign);

  const batchCap = campaign.batchCap ?? config.throttle.batchCap;
  const toSend = queued.slice(0, batchCap);
  for (const r of queued.slice(batchCap)) {
    skipped.push({ ...r, reason: `batch cap reached (${batchCap} per run)` });
  }

  const results = [];
  onProgress({ type: 'start', total: toSend.length, skipped: skipped.length, dryRun, remaining, dailyCap });

  // Fail fast on a bad template rather than sending half a campaign.
  const composed = toSend.map((r) => ({ recipient: r, message: composeMessage(r, campaign) }));

  const transport = dryRun ? null : getTransport();

  for (let i = 0; i < composed.length; i += 1) {
    const { recipient, message } = composed[i];
    const started = Date.now();

    try {
      let messageId = null;
      if (!dryRun) {
        const info = await transport.sendMail({
          from: config.from.name
            ? { name: config.from.name, address: config.from.email }
            : config.from.email,
          to: recipient.email,
          replyTo: config.replyTo || undefined,
          bcc: config.bccSelf ? config.from.email : undefined,
          subject: message.subject,
          text: message.text,
          html: message.html,
          attachments: attachments.map((a) => ({ filename: a.filename, path: a.path })),
        });
        messageId = info.messageId;
      }

      const entry = {
        email: recipient.email,
        company: recipient.company,
        hiring_manager: recipient.hiring_manager,
        role: recipient.role,
        subject: message.subject,
        status: dryRun ? 'dry-run' : 'sent',
        messageId,
        attachments: attachments.map((a) => a.filename),
        ms: Date.now() - started,
      };
      if (!dryRun) await store.recordSend(entry);
      results.push(entry);
      onProgress({ type: 'sent', index: i, total: composed.length, ...entry });
    } catch (err) {
      const entry = {
        email: recipient.email,
        company: recipient.company,
        subject: message.subject,
        status: 'failed',
        error: err.message,
        ms: Date.now() - started,
      };
      if (!dryRun) await store.recordSend(entry);
      results.push(entry);
      onProgress({ type: 'failed', index: i, total: composed.length, ...entry });
    }

    // Human-ish spacing between messages, but never after the last one.
    if (!dryRun && i < composed.length - 1) {
      const { delayMs, jitterMs } = config.throttle;
      const wait = (campaign.delayMs ?? delayMs) + Math.random() * (campaign.jitterMs ?? jitterMs);
      onProgress({ type: 'waiting', ms: Math.round(wait) });
      await sleep(wait);
    }
  }

  const summary = {
    total: recipients.length,
    sent: results.filter((r) => r.status === 'sent').length,
    dryRun: results.filter((r) => r.status === 'dry-run').length,
    failed: results.filter((r) => r.status === 'failed').length,
    skipped,
    results,
  };
  onProgress({ type: 'done', ...summary });
  return summary;
}

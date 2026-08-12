/** Local web UI + JSON API. Binds to loopback only - this holds your SMTP session. */

import express from 'express';
import path from 'node:path';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { config, projectRoot, publicConfig, smtpConfigured } from './lib/config.js';
import { parseRecipients } from './lib/recipients.js';
import { composeMessage, listAttachments, planCampaign, sendCampaign, verifyTransport } from './lib/mailer.js';
import * as store from './lib/store.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app = express();
app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname, '..', 'public')));

const wrap = (fn) => (req, res) => fn(req, res).catch((err) => {
  res.status(err.status || 400).json({ error: err.message });
});

app.get('/api/config', wrap(async (_req, res) => {
  res.json({ ...publicConfig(), attachments: await listAttachments() });
}));

app.post('/api/verify', wrap(async (_req, res) => {
  await verifyTransport();
  res.json({ ok: true, message: `Connected to ${config.smtp.host} as ${config.smtp.user}` });
}));

app.post('/api/parse', wrap(async (req, res) => {
  const { raw, inferManagerFromMailbox } = req.body || {};
  const parsed = parseRecipients(raw, { inferManagerFromMailbox });
  const plan = await planCampaign(parsed.recipients, req.body?.campaign || {});
  res.json({ ...parsed, plan: { skipped: plan.skipped, sentToday: plan.sentToday, dailyCap: plan.dailyCap, remaining: plan.remaining } });
}));

app.post('/api/preview', wrap(async (req, res) => {
  const { recipients = [], subject = '', body = '', limit = 5 } = req.body || {};
  const previews = recipients.slice(0, limit).map((r) => {
    try {
      const m = composeMessage(r, { subject, body });
      return { email: r.email, subject: m.subject, text: m.text, html: m.html, ok: true };
    } catch (err) {
      return { email: r.email, ok: false, error: err.message };
    }
  });
  res.json({ previews });
}));

// Jobs are held in memory: a campaign is short-lived and tied to this process.
const jobs = new Map();

app.post('/api/send', wrap(async (req, res) => {
  const { recipients = [], subject, body, attachments = [], dryRun = true,
    allowResend = false, batchCap, delayMs } = req.body || {};

  if (!subject || !body) throw new Error('Subject and body are required');
  if (!recipients.length) throw new Error('No recipients');
  if (!dryRun && !smtpConfigured()) throw new Error('SMTP is not configured - see .env.example');

  const id = `job_${Date.now().toString(36)}`;
  const job = { id, events: [], status: 'running', startedAt: new Date().toISOString() };
  jobs.set(id, job);

  const campaign = { subject, body, attachments, dryRun, allowResend, batchCap, delayMs };
  sendCampaign(recipients, campaign, (ev) => job.events.push({ ...ev, at: Date.now() }))
    .then((summary) => { job.status = 'done'; job.summary = summary; })
    .catch((err) => { job.status = 'error'; job.error = err.message; });

  res.json({ id });
}));

app.get('/api/jobs/:id', wrap(async (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) { const e = new Error('No such job'); e.status = 404; throw e; }
  const since = Number(req.query.since || 0);
  res.json({ status: job.status, error: job.error, summary: job.summary, events: job.events.slice(since) });
}));

app.get('/api/history', wrap(async (_req, res) => {
  const log = await store.getSent();
  res.json({ sent: log.slice(-500).reverse(), total: log.length, last24h: await store.sentWithin(24) });
}));

app.get('/api/suppression', wrap(async (_req, res) => res.json(await store.getSuppression())));

app.post('/api/suppression', wrap(async (req, res) => {
  const { email, reason } = req.body || {};
  if (!email) throw new Error('email is required');
  res.json(await store.suppress(email, reason));
}));

app.delete('/api/suppression/:email', wrap(async (req, res) => {
  res.json(await store.unsuppress(req.params.email));
}));

app.get('/api/templates', wrap(async (_req, res) => res.json(await store.getTemplates())));

app.post('/api/templates', wrap(async (req, res) => {
  const { name, subject, body } = req.body || {};
  if (!name) throw new Error('Template name is required');
  res.json(await store.saveTemplate(name, { subject, body }));
}));

app.delete('/api/templates/:name', wrap(async (req, res) => {
  res.json(await store.deleteTemplate(req.params.name));
}));

app.listen(config.port, '127.0.0.1', () => {
  const envPath = path.join(projectRoot, '.env');
  const envFound = existsSync(envPath);

  console.log(`\n  Resume Mailer  ->  http://127.0.0.1:${config.port}`);
  console.log(`  env    ${envFound ? 'loaded' : 'MISSING'}  ${envPath}`);
  console.log(`  smtp   ${smtpConfigured() ? `ready (${config.smtp.user})` : 'not configured'}`);
  console.log(`  files  ${config.attachmentsDir}\n`);

  if (!envFound) {
    console.log('  No .env at the path above. Copy .env.example to .env in the project root.\n');
  } else if (!smtpConfigured()) {
    console.log('  .env found but SMTP_HOST/SMTP_USER/SMTP_PASS are incomplete.');
    console.log('  Dry-run previews still work.\n');
  }
});

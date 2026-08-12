/**
 * Flat-file persistence: send log, suppression list, saved templates.
 *
 * JSON on disk is the right call at this size - it is inspectable, diffable and
 * trivially backed up. The interface is async and keyed so that swapping in
 * SQLite/Postgres later (if this ever becomes a product) is a contained change.
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';

import { projectRoot } from './config.js';

// Anchored to the project root, not the cwd: the send log and suppression list
// must be the same files no matter which directory the app was launched from.
// Splitting them per-cwd would silently defeat the duplicate-contact guard.
const DATA_DIR = path.resolve(projectRoot, process.env.DATA_DIR || 'data');

const FILES = {
  sent: path.join(DATA_DIR, 'sent.json'),
  suppression: path.join(DATA_DIR, 'suppression.json'),
  templates: path.join(DATA_DIR, 'templates.json'),
};

async function readJson(file, fallback) {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT') return fallback;
    if (err instanceof SyntaxError) {
      // Never lose data to a half-written file - park it and carry on.
      await fs.rename(file, `${file}.corrupt-${Date.now()}`).catch(() => {});
      return fallback;
    }
    throw err;
  }
}

async function writeJson(file, data) {
  await fs.mkdir(DATA_DIR, { recursive: true });
  const tmp = `${file}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(data, null, 2), 'utf8');
  await fs.rename(tmp, file); // atomic swap, so a crash mid-write cannot truncate
}

// ---------------------------------------------------------------- send log

export async function getSent() {
  return readJson(FILES.sent, []);
}

export async function recordSend(entry) {
  const log = await getSent();
  log.push({ ...entry, at: entry.at || new Date().toISOString() });
  await writeJson(FILES.sent, log);
  return entry;
}

/** email -> most recent successful send, for "already contacted" checks. */
export async function sentIndex() {
  const log = await getSent();
  const idx = new Map();
  for (const e of log) {
    if (e.status !== 'sent') continue;
    const key = String(e.email).toLowerCase();
    const prev = idx.get(key);
    if (!prev || new Date(e.at) > new Date(prev.at)) idx.set(key, e);
  }
  return idx;
}

/** How many messages went out in the trailing `hours` window. */
export async function sentWithin(hours = 24) {
  const cutoff = Date.now() - hours * 3600 * 1000;
  const log = await getSent();
  return log.filter((e) => e.status === 'sent' && new Date(e.at).getTime() >= cutoff).length;
}

// ------------------------------------------------------------- suppression

export async function getSuppression() {
  return readJson(FILES.suppression, []);
}

export async function isSuppressed(email) {
  const list = await getSuppression();
  return list.some((s) => s.email.toLowerCase() === String(email).toLowerCase());
}

export async function suppress(email, reason = 'manual') {
  const list = await getSuppression();
  const key = String(email).toLowerCase();
  if (list.some((s) => s.email.toLowerCase() === key)) return list;
  list.push({ email: key, reason, at: new Date().toISOString() });
  await writeJson(FILES.suppression, list);
  return list;
}

export async function unsuppress(email) {
  const key = String(email).toLowerCase();
  const list = (await getSuppression()).filter((s) => s.email.toLowerCase() !== key);
  await writeJson(FILES.suppression, list);
  return list;
}

// ---------------------------------------------------------------- templates

export async function getTemplates() {
  return readJson(FILES.templates, {});
}

export async function saveTemplate(name, { subject, body }) {
  const all = await getTemplates();
  all[name] = { subject, body, updatedAt: new Date().toISOString() };
  await writeJson(FILES.templates, all);
  return all;
}

export async function deleteTemplate(name) {
  const all = await getTemplates();
  delete all[name];
  await writeJson(FILES.templates, all);
  return all;
}

export const paths = { DATA_DIR, ...FILES };

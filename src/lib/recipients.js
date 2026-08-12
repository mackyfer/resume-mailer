/**
 * Recipient list parsing.
 *
 * Accepts a deliberately sloppy blob of text, because that is how contact lists
 * actually arrive - pasted out of a spreadsheet, a job board, or a notes app.
 *
 * Supported per-entry forms:
 *   jane@acme.com
 *   Jane Doe <jane@acme.com>
 *   jane@acme.com | Acme Corp | Jane Doe | Senior Engineer
 *   jane@acme.com, Acme Corp, Jane Doe            (CSV, only when a header row is present)
 *
 * Entries are separated by newlines, commas, semicolons or whitespace. Commas are
 * only treated as *field* separators when the block is detected as CSV via a
 * header row; otherwise a comma is an entry separator. That is what lets a plain
 * "a@x.com, b@y.com, c@z.com" list work exactly as expected.
 */

const EMAIL_RE = /^[^\s@<>,;]+@[^\s@<>,;]+\.[^\s@<>,;]+$/;
const ANGLE_RE = /^(.*?)<([^>]+)>$/;

/** Multi-part public suffixes we should skip past when guessing a company name. */
const COMPOUND_TLDS = new Set([
  'co.uk', 'org.uk', 'ac.uk', 'gov.uk', 'co.jp', 'com.au', 'co.nz', 'com.br',
  'co.za', 'com.gh', 'org.gh', 'gov.gh', 'com.jm', 'org.jm', 'gov.jm', 'com.ng',
]);

/** Free mail providers - the domain tells us nothing about the company. */
const GENERIC_DOMAINS = new Set([
  'gmail.com', 'googlemail.com', 'yahoo.com', 'yahoo.co.uk', 'hotmail.com',
  'outlook.com', 'live.com', 'aol.com', 'icloud.com', 'me.com', 'proton.me',
  'protonmail.com', 'gmx.com', 'zoho.com', 'mail.com', 'yandex.com',
]);

/** Mailbox names that are a department, never a person. */
const ROLE_MAILBOXES = new Set([
  'hr', 'jobs', 'job', 'careers', 'career', 'recruiting', 'recruitment',
  'recruit', 'hiring', 'talent', 'apply', 'applications', 'cv', 'resumes',
  'info', 'contact', 'hello', 'admin', 'office', 'people', 'team',
]);

export function isEmail(value) {
  return EMAIL_RE.test(String(value || '').trim());
}

/**
 * Guess a display-ready company name from an email domain.
 * "careers@acme-corp.com" -> "Acme Corp". Returns null for free mail providers,
 * so the caller can fall back rather than writing "Dear Gmail Team".
 */
export function companyFromEmail(email) {
  const domain = String(email).split('@')[1];
  if (!domain) return null;

  const host = domain.toLowerCase().replace(/^(www|mail|email|careers|jobs)\./, '');
  if (GENERIC_DOMAINS.has(host)) return null;

  const parts = host.split('.');
  let name = parts[0];
  if (parts.length > 2) {
    const lastTwo = parts.slice(-2).join('.');
    // e.g. acme.co.uk -> "acme"; but jobs.acme.com -> "acme"
    name = COMPOUND_TLDS.has(lastTwo) ? parts[parts.length - 3] : parts[parts.length - 2];
  }

  return name
    .split(/[-_]+/)
    .filter(Boolean)
    .map((w) => (w.length <= 3 ? w.toUpperCase() : w[0].toUpperCase() + w.slice(1)))
    .join(' ');
}

/**
 * A mailbox like "jane.doe@acme.com" implies a person; "careers@acme.com" does not.
 * Used only as a last resort, and never to invent a surname.
 */
export function personFromEmail(email) {
  const local = String(email).split('@')[0].toLowerCase();
  if (ROLE_MAILBOXES.has(local.replace(/[._-]/g, ''))) return null;
  if (/^\d+$/.test(local)) return null;

  const words = local.split(/[._-]+/).filter((w) => w.length > 1 && /^[a-z]+$/.test(w));
  if (!words.length) return null;
  if (words.length === 1 && ROLE_MAILBOXES.has(words[0])) return null;

  return words.map((w) => w[0].toUpperCase() + w.slice(1)).join(' ');
}

function splitCsvLine(line) {
  const out = [];
  let cur = '';
  let quoted = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (ch === '"') {
      if (quoted && line[i + 1] === '"') { cur += '"'; i += 1; } else { quoted = !quoted; }
    } else if (ch === ',' && !quoted) {
      out.push(cur); cur = '';
    } else {
      cur += ch;
    }
  }
  out.push(cur);
  return out.map((s) => s.trim());
}

const HEADER_ALIASES = {
  email: 'email', 'e-mail': 'email', mail: 'email', address: 'email',
  company: 'company', organisation: 'company', organization: 'company', employer: 'company',
  manager: 'hiring_manager', 'hiring manager': 'hiring_manager', hiring_manager: 'hiring_manager',
  contact: 'hiring_manager', name: 'hiring_manager', recruiter: 'hiring_manager',
  role: 'role', position: 'role', job: 'role', title: 'role', 'job title': 'role',
  notes: 'notes', note: 'notes', source: 'source', url: 'source', link: 'source',
};

function looksLikeCsvHeader(line) {
  const cells = splitCsvLine(line).map((c) => c.toLowerCase());
  if (cells.length < 2) return false;
  if (cells.some((c) => isEmail(c))) return false; // a data row, not a header
  return cells.some((c) => HEADER_ALIASES[c] === 'email');
}

function normaliseEntry(entry) {
  const email = String(entry.email || '').trim().toLowerCase();
  const company = (entry.company || '').trim() || companyFromEmail(email) || '';
  const hiringManager = (entry.hiring_manager || '').trim();
  return {
    email,
    company,
    hiring_manager: hiringManager,
    role: (entry.role || '').trim(),
    notes: (entry.notes || '').trim(),
    source: (entry.source || '').trim(),
  };
}

/**
 * Parse a raw blob into recipients.
 * @returns {{recipients: Array, errors: Array<{value:string, reason:string}>, duplicates: string[]}}
 */
export function parseRecipients(raw, options = {}) {
  const { inferManagerFromMailbox = false } = options;
  const text = String(raw || '').replace(/\r\n/g, '\n').trim();
  if (!text) return { recipients: [], errors: [], duplicates: [] };

  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
  const errors = [];
  const seen = new Map();
  const duplicates = [];
  const out = [];

  const push = (entry) => {
    const rec = normaliseEntry(entry);
    if (!isEmail(rec.email)) {
      errors.push({ value: entry.email || JSON.stringify(entry), reason: 'not a valid email address' });
      return;
    }
    if (seen.has(rec.email)) {
      duplicates.push(rec.email);
      // Later rows may carry richer data; fill blanks on the entry we already kept.
      const existing = seen.get(rec.email);
      for (const k of ['company', 'hiring_manager', 'role', 'notes', 'source']) {
        if (!existing[k] && rec[k]) existing[k] = rec[k];
      }
      return;
    }
    if (inferManagerFromMailbox && !rec.hiring_manager) {
      rec.hiring_manager = personFromEmail(rec.email) || '';
    }
    seen.set(rec.email, rec);
    out.push(rec);
  };

  // --- CSV mode: only when the first line is unambiguously a header row.
  if (looksLikeCsvHeader(lines[0])) {
    const header = splitCsvLine(lines[0]).map((h) => HEADER_ALIASES[h.toLowerCase()] || null);
    for (const line of lines.slice(1)) {
      const cells = splitCsvLine(line);
      if (!cells.some(Boolean)) continue;
      const entry = {};
      header.forEach((key, i) => { if (key && cells[i]) entry[key] = cells[i]; });
      push(entry);
    }
    return { recipients: out, errors, duplicates };
  }

  // --- Freeform mode.
  for (const line of lines) {
    if (line.includes('|')) {
      const [email, company, manager, role, notes] = line.split('|').map((s) => s.trim());
      push({ email: stripAngle(email).email, company, hiring_manager: manager, role, notes });
      continue;
    }

    // "Jane Doe <jane@acme.com>" may itself sit in a comma-separated list, so pull
    // the angle-bracket forms out first and split whatever remains.
    const angleMatches = [...line.matchAll(/([^,;<]*)<([^>]+)>/g)];
    if (angleMatches.length) {
      for (const [, label, email] of angleMatches) {
        const name = label.trim().replace(/^["']|["']$/g, '');
        push({ email: email.trim(), hiring_manager: name });
      }
      const rest = line.replace(/[^,;<]*<[^>]+>/g, ' ');
      for (const tok of rest.split(/[,;\s]+/).filter(Boolean)) push({ email: tok });
      continue;
    }

    for (const tok of line.split(/[,;\s]+/).filter(Boolean)) push({ email: tok });
  }

  return { recipients: out, errors, duplicates };
}

function stripAngle(value) {
  const m = ANGLE_RE.exec(String(value || '').trim());
  if (!m) return { name: '', email: String(value || '').trim() };
  return { name: m[1].trim(), email: m[2].trim() };
}

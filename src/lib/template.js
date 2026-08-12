/**
 * A very small mustache-ish renderer.
 *
 * Deliberately not a general template engine: it supports exactly what an
 * outreach email needs, and it fails loudly on unknown variables so a typo can
 * never go out as a literal "{{compnay}}" to fifty hiring managers.
 *
 * Supported:
 *   {{var}}                        - substitution (HTML-escaped in html mode)
 *   {{#if var}}...{{/if}}          - block, rendered when var is non-empty
 *   {{#if var}}...{{else}}...{{/if}}
 */

const VAR_RE = /\{\{\s*([a-z0-9_]+)\s*\}\}/gi;
const IF_RE = /\{\{#if\s+([a-z0-9_]+)\s*\}\}([\s\S]*?)\{\{\/if\}\}/gi;

export class TemplateError extends Error {}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Build the variable bag for one recipient, applying fallbacks.
 * `greeting` is derived rather than hand-written so that a missing hiring
 * manager degrades to "Dear Hiring Team" instead of "Dear ,".
 */
export function buildVars(recipient, settings = {}) {
  const manager = (recipient.hiring_manager || '').trim();
  const company = (recipient.company || '').trim();
  const fallbackGreeting = settings.fallbackGreeting || 'Hiring Team';

  const firstName = manager ? manager.split(/\s+/)[0] : '';
  const honorific = manager || fallbackGreeting;

  return {
    email: recipient.email || '',
    company: company || settings.fallbackCompany || 'your team',
    hiring_manager: manager,
    first_name: firstName,
    greeting: `Dear ${manager ? firstName : fallbackGreeting}`,
    greeting_full: `Dear ${honorific}`,
    role: (recipient.role || settings.defaultRole || '').trim(),
    notes: recipient.notes || '',
    source: recipient.source || '',
    my_name: settings.myName || '',
    my_email: settings.myEmail || '',
    my_phone: settings.myPhone || '',
    my_linkedin: settings.myLinkedin || '',
    my_github: settings.myGithub || '',
    my_location: settings.myLocation || '',
    ...(settings.extraVars || {}),
  };
}

/** Every variable name a template references, in order of first appearance. */
export function usedVariables(template) {
  const names = new Set();
  const src = String(template || '');
  for (const [, name] of src.matchAll(IF_RE)) names.add(name.toLowerCase());
  for (const [, name] of src.matchAll(VAR_RE)) names.add(name.toLowerCase());
  return [...names];
}

/**
 * @param {string} template
 * @param {object} vars
 * @param {{html?: boolean, strict?: boolean}} opts
 */
export function render(template, vars, opts = {}) {
  const { html = false, strict = true } = opts;
  const bag = {};
  for (const [k, v] of Object.entries(vars || {})) bag[k.toLowerCase()] = v;

  const missing = new Set();
  const get = (name) => {
    const key = name.toLowerCase();
    if (!(key in bag)) { missing.add(name); return ''; }
    const v = bag[key];
    return v === null || v === undefined ? '' : String(v);
  };

  let out = String(template || '');

  // Conditionals first, so variables inside a false branch are never demanded.
  let guard = 0;
  while (IF_RE.test(out)) {
    if (guard += 1, guard > 20) throw new TemplateError('Template nests {{#if}} too deeply');
    IF_RE.lastIndex = 0;
    out = out.replace(IF_RE, (_m, name, inner) => {
      const [truthy, falsy = ''] = inner.split(/\{\{\s*else\s*\}\}/i);
      return get(name).trim() ? truthy : falsy;
    });
    IF_RE.lastIndex = 0;
  }

  out = out.replace(VAR_RE, (_m, name) => {
    const value = get(name);
    return html ? escapeHtml(value) : value;
  });

  if (strict && missing.size) {
    throw new TemplateError(
      `Unknown template variable(s): ${[...missing].map((m) => `{{${m}}}`).join(', ')}. ` +
      `Available: ${Object.keys(bag).map((k) => `{{${k}}}`).join(', ')}`,
    );
  }

  return out;
}

/** Plain-text body -> simple, mail-client-safe HTML. */
export function textToHtml(text) {
  const paragraphs = String(text).trim().split(/\n{2,}/);
  const body = paragraphs
    .map((p) => {
      const lines = p.split('\n').map(escapeHtml);
      if (lines.every((l) => /^\s*[-*]\s+/.test(l)) && lines.length > 1) {
        const items = lines.map((l) => `<li>${l.replace(/^\s*[-*]\s+/, '')}</li>`).join('');
        return `<ul style="margin:0 0 16px 20px;padding:0">${items}</ul>`;
      }
      return `<p style="margin:0 0 16px">${lines.join('<br>')}</p>`;
    })
    .join('\n');

  return [
    '<!doctype html><html><body style="margin:0;padding:0;background:#ffffff">',
    '<div style="font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;',
    'font-size:15px;line-height:1.55;color:#1a1a1a;max-width:640px">',
    body,
    '</div></body></html>',
  ].join('');
}

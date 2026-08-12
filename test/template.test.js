import test from 'node:test';
import assert from 'node:assert/strict';

import { render, buildVars, usedVariables, TemplateError, textToHtml } from '../src/lib/template.js';

const me = { myName: 'Ricardo McPherson', myEmail: 'r@example.com', myPhone: '+00 00 000 0000' };

test('substitutes plain variables', () => {
  const vars = buildVars({ email: 'a@acme.com', company: 'Acme' }, me);
  assert.equal(render('Hello {{company}} from {{my_name}}', vars),
    'Hello Acme from Ricardo McPherson');
});

test('greeting uses the manager first name when present', () => {
  const vars = buildVars({ email: 'a@acme.com', hiring_manager: 'Jane Doe' }, me);
  assert.equal(vars.greeting, 'Dear Jane');
  assert.equal(vars.greeting_full, 'Dear Jane Doe');
});

test('greeting falls back when no manager is known', () => {
  const vars = buildVars({ email: 'hr@acme.com' }, { ...me, fallbackGreeting: 'Hiring Team' });
  assert.equal(vars.greeting, 'Dear Hiring Team');
});

test('company falls back rather than rendering empty', () => {
  const vars = buildVars({ email: 'a@x.com' }, me);
  assert.equal(vars.company, 'your team');
});

test('if-block renders when the value is present', () => {
  const vars = buildVars({ email: 'a@acme.com', role: 'Staff Engineer' }, me);
  assert.equal(render('{{#if role}}the {{role}} role{{else}}open roles{{/if}}', vars),
    'the Staff Engineer role');
});

test('if-block takes the else branch when absent', () => {
  const vars = buildVars({ email: 'a@acme.com' }, me);
  assert.equal(render('{{#if role}}the {{role}} role{{else}}open roles{{/if}}', vars), 'open roles');
});

test('if-block with no else collapses to nothing', () => {
  const vars = buildVars({ email: 'a@acme.com' }, me);
  assert.equal(render('Hi{{#if hiring_manager}}, {{first_name}}{{/if}}!', vars), 'Hi!');
});

test('unknown variables throw instead of shipping a broken email', () => {
  const vars = buildVars({ email: 'a@acme.com' }, me);
  assert.throws(() => render('Hello {{compnay}}', vars), TemplateError);
});

test('a typo inside a false branch is still caught on the true path only', () => {
  const vars = buildVars({ email: 'a@acme.com' }, me);
  // role is empty -> the true branch never renders, so its contents are not demanded
  assert.doesNotThrow(() => render('{{#if role}}{{nonexistent}}{{else}}fine{{/if}}', vars));
});

test('html mode escapes injected values', () => {
  const vars = buildVars({ email: 'a@acme.com', company: '<script>x</script>' }, me);
  assert.equal(render('{{company}}', vars, { html: true }), '&lt;script&gt;x&lt;/script&gt;');
});

test('usedVariables lists everything referenced', () => {
  const names = usedVariables('{{greeting}} {{#if role}}{{role}}{{/if}} {{my_name}}');
  assert.deepEqual(new Set(names), new Set(['greeting', 'role', 'my_name']));
});

test('textToHtml escapes content and preserves paragraphs', () => {
  const html = textToHtml('Hello <b>there</b>\n\nSecond para');
  assert.match(html, /&lt;b&gt;there&lt;\/b&gt;/);
  assert.equal((html.match(/<p /g) || []).length, 2);
});

test('textToHtml turns dash lists into real bullets', () => {
  const html = textToHtml('Intro\n\n- one\n- two\n- three');
  assert.match(html, /<ul/);
  assert.equal((html.match(/<li>/g) || []).length, 3);
});

test('the shipped default template renders for a bare address', () => {
  const body = `{{greeting}},

I'm writing about {{#if role}}the {{role}} role at {{company}}{{else}}roles at {{company}}{{/if}}.

Best,
{{my_name}}`;
  const vars = buildVars({ email: 'careers@acme.com', company: 'Acme' }, me);
  const out = render(body, vars);
  assert.match(out, /^Dear Hiring Team,/);
  assert.match(out, /roles at Acme/);
  assert.doesNotMatch(out, /\{\{/);
});

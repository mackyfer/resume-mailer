import test from 'node:test';
import assert from 'node:assert/strict';

import { parseRecipients, companyFromEmail, personFromEmail } from '../src/lib/recipients.js';

test('comma-separated list', () => {
  const { recipients } = parseRecipients('a@acme.com, b@globex.com,c@initech.com');
  assert.deepEqual(recipients.map((r) => r.email), ['a@acme.com', 'b@globex.com', 'c@initech.com']);
});

test('space- and newline-separated list', () => {
  const { recipients } = parseRecipients('a@acme.com b@globex.com\n\nc@initech.com   d@umbrella.com');
  assert.equal(recipients.length, 4);
});

test('semicolons and mixed whitespace', () => {
  const { recipients } = parseRecipients('a@acme.com; b@globex.com ,\tc@initech.com');
  assert.equal(recipients.length, 3);
});

test('company is inferred from the domain', () => {
  const { recipients } = parseRecipients('careers@acme-corp.com');
  assert.equal(recipients[0].company, 'Acme Corp');
});

test('free mail domains do not become company names', () => {
  assert.equal(companyFromEmail('someone@gmail.com'), null);
  const { recipients } = parseRecipients('someone@gmail.com');
  assert.equal(recipients[0].company, '');
});

test('compound TLDs resolve to the right label', () => {
  assert.equal(companyFromEmail('hr@bigco.co.uk'), 'Bigco');
  assert.equal(companyFromEmail('jobs@sub.bigco.com'), 'Bigco');
});

test('pipe form carries company, manager and role', () => {
  const { recipients } = parseRecipients('jane@acme.com | Acme Corp | Jane Doe | Staff Engineer');
  assert.deepEqual(recipients[0], {
    email: 'jane@acme.com', company: 'Acme Corp', hiring_manager: 'Jane Doe',
    role: 'Staff Engineer', notes: '', source: '',
  });
});

test('angle-bracket names are captured as the hiring manager', () => {
  const { recipients } = parseRecipients('Jane Doe <jane@acme.com>, Bob <bob@globex.com>');
  assert.equal(recipients[0].hiring_manager, 'Jane Doe');
  assert.equal(recipients[1].email, 'bob@globex.com');
  assert.equal(recipients[1].hiring_manager, 'Bob');
});

test('angle-bracket entries mixed with bare addresses', () => {
  const { recipients } = parseRecipients('Jane Doe <jane@acme.com>, plain@globex.com');
  assert.equal(recipients.length, 2);
  assert.equal(recipients[1].email, 'plain@globex.com');
});

test('CSV with a header row', () => {
  const csv = 'email,company,manager,role\njane@acme.com,Acme Corp,Jane Doe,Backend Engineer\nhr@globex.com,Globex,,';
  const { recipients } = parseRecipients(csv);
  assert.equal(recipients.length, 2);
  assert.equal(recipients[0].hiring_manager, 'Jane Doe');
  assert.equal(recipients[1].company, 'Globex');
  assert.equal(recipients[1].hiring_manager, '');
});

test('CSV quoting survives commas inside fields', () => {
  const csv = 'email,company\njane@acme.com,"Acme, Inc."';
  const { recipients } = parseRecipients(csv);
  assert.equal(recipients[0].company, 'Acme, Inc.');
});

test('a plain comma list is never mistaken for CSV', () => {
  const { recipients } = parseRecipients('a@x.com,b@y.com');
  assert.equal(recipients.length, 2);
});

test('duplicates are collapsed and later detail is merged in', () => {
  const { recipients, duplicates } = parseRecipients(
    'jane@acme.com\njane@acme.com | Acme Corp | Jane Doe',
  );
  assert.equal(recipients.length, 1);
  assert.equal(duplicates.length, 1);
  assert.equal(recipients[0].hiring_manager, 'Jane Doe');
});

test('addresses are lowercased for reliable dedupe', () => {
  const { recipients } = parseRecipients('Jane@Acme.com, jane@acme.com');
  assert.equal(recipients.length, 1);
  assert.equal(recipients[0].email, 'jane@acme.com');
});

test('invalid entries are reported, not silently dropped', () => {
  const { recipients, errors } = parseRecipients('good@acme.com, not-an-email, @nope.com');
  assert.equal(recipients.length, 1);
  assert.equal(errors.length, 2);
});

test('role mailboxes never produce a fake person name', () => {
  assert.equal(personFromEmail('careers@acme.com'), null);
  assert.equal(personFromEmail('hr@acme.com'), null);
  assert.equal(personFromEmail('jane.doe@acme.com'), 'Jane Doe');
});

test('manager inference is opt-in', () => {
  const off = parseRecipients('jane.doe@acme.com').recipients[0];
  assert.equal(off.hiring_manager, '');
  const on = parseRecipients('jane.doe@acme.com', { inferManagerFromMailbox: true }).recipients[0];
  assert.equal(on.hiring_manager, 'Jane Doe');
});

test('empty input is not an error', () => {
  assert.deepEqual(parseRecipients('   '), { recipients: [], errors: [], duplicates: [] });
});

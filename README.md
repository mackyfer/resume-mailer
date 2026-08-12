# Resume Mailer

Sends a personalised application email + CV attachment to a list of contacts.
Local-first: a small Express app and a CLI, your own SMTP, flat-file storage.

```bash
npm install
cp .env.example .env      # then fill in SMTP_PASS
npm start                 # http://127.0.0.1:3737
```

Dry run is the default everywhere. Nothing is delivered until you explicitly
turn it off in the UI or pass `--send` on the CLI.

## Setting up SMTP

Gmail will not accept your account password. Enable 2-Step Verification, then
create an **App Password** at <https://myaccount.google.com/apppasswords> and put
that 16-character value in `SMTP_PASS`.

| Provider   | Host                 | Port |
|------------|----------------------|------|
| Gmail      | `smtp.gmail.com`     | 587  |
| Outlook    | `smtp.office365.com` | 587  |
| Fastmail   | `smtp.fastmail.com`  | 465  |

Click **Test SMTP** in the header to confirm the connection before a real run.

## Recipient formats

All of these work, mixed freely in the same paste:

```
jane@acme.com, careers@globex.com hr@initech.com     # comma / space / newline
Jane Doe <jane@acme.com>                             # name captured as manager
jane@acme.com | Acme Corp | Jane Doe | Staff Engineer
```

CSV also works, but **only with a header row** — that is what stops a plain
comma-separated list from being misread as columns:

```csv
email,company,manager,role
jane@acme.com,Acme Corp,Jane Doe,Backend Engineer
hr@globex.com,Globex,,
```

Recognised headers: `email`, `company`, `manager`/`hiring manager`/`contact`,
`role`/`position`/`title`, `notes`, `source`.

**Company is inferred from the domain** when you don't supply one
(`careers@acme-corp.com` → "Acme Corp"). Free mail domains are left blank
rather than producing "Dear Gmail Team". Checking *Guess hiring manager from
mailbox* turns `jane.doe@acme.com` into "Jane Doe", but never invents a name
from a role mailbox like `careers@` or `hr@`.

## Template variables

| Variable | Notes |
|---|---|
| `{{greeting}}` | "Dear Jane" or "Dear Hiring Team" |
| `{{greeting_full}}` | Uses the full name: "Dear Jane Doe" |
| `{{company}}` | Supplied, or inferred from the domain |
| `{{hiring_manager}}`, `{{first_name}}` | Empty when unknown |
| `{{role}}`, `{{notes}}`, `{{source}}` | Per recipient |
| `{{my_name}}` `{{my_email}}` `{{my_phone}}` `{{my_linkedin}}` `{{my_github}}` `{{my_location}}` | From `.env` |

Conditionals keep the copy natural when a field is missing:

```
{{#if role}}the {{role}} role at {{company}}{{else}}engineering roles at {{company}}{{/if}}
{{#if hiring_manager}}, and I'm happy to work around your schedule{{/if}}
```

A typo in a variable name raises an error instead of mailing a literal
`{{compnay}}` to fifty people.

## Safety rails

These exist because the failure modes are public and permanent:

- **Send log** (`data/sent.json`) — an address you have already emailed is
  skipped. Override per-run with *Allow re-contacting* / `--allow-resend`.
- **Suppression list** (`data/suppression.json`) — permanent, and **not**
  overridable by `--allow-resend`. Add anyone who asks not to be contacted.
- **Daily cap** (`DAILY_CAP`, default 40) — enforced against the log, so it
  survives restarts.
- **Batch cap** (`BATCH_CAP`, default 25) — ceiling for a single run.
- **Throttle** (`SEND_DELAY_MS` + jitter, default 8–12s) — bursts are what get
  a personal mailbox rate-limited and spam-foldered.
- **Dry run by default**, and a typed confirmation before any live run.
- **BCC yourself** (`BCC_SELF=true`) so replies thread against a real sent item.

## CLI

```bash
node src/cli.js --to "a@x.com, b@y.com" --template templates/default.md
node src/cli.js --to-file contacts.csv --template templates/default.md \
  --attach Ricardo-McPherson-CV-ATS.pdf --batch 10 --send
```

| Flag | Meaning |
|---|---|
| `--to`, `--to-file` | Recipient list inline or from a file |
| `--template` | File with `Subject: ...`, a blank line, then the body |
| `--attach` | Filename inside `attachments/` (repeatable) |
| `--role` | Default `{{role}}` for recipients without one |
| `--batch`, `--delay` | Per-run ceiling and gap in ms |
| `--allow-resend` | Permit addresses already in the send log |
| `--send` | Actually deliver. Omit for a dry run |

## Layout

```
src/lib/recipients.js   parsing, dedupe, company/person inference
src/lib/template.js     renderer with conditionals and strict unknown-var checks
src/lib/mailer.js       plan + throttle + send + log
src/lib/store.js        atomic JSON persistence
src/server.js           JSON API + static UI      src/cli.js  headless sender
attachments/            files offered as attachments
data/                   sent log, suppression, saved templates (gitignored)
```

`npm test` — 32 tests over parsing and rendering.

## Before you send to strangers

Cold outreach to a role mailbox (`careers@`, `hr@`) about a genuine job
application is normal and expected. Bulk-mailing scraped personal addresses is
not, and in the EU/UK it engages GDPR and PECR regardless of intent. Keep the
lists small and targeted, keep the volume low, and honour every opt-out
immediately — that is what the suppression list is for.

## If this becomes a product

The parts that would need to change first: SMTP credentials belong in a secret
store rather than `.env`; `store.js` swaps to Postgres behind the same
interface; sending moves to a durable queue so a crash cannot lose or duplicate
a message; and a commercial sender needs per-tenant domain auth (SPF/DKIM/
DMARC), one-click unsubscribe headers, and bounce/complaint webhooks — the
latter two are legal requirements for commercial bulk mail in most
jurisdictions, not nice-to-haves.

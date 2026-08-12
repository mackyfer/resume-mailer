/** Environment-backed settings. Credentials live in .env and are never sent to the browser. */

import 'dotenv/config';
import path from 'node:path';

const bool = (v, dflt = false) => (v === undefined ? dflt : /^(1|true|yes|on)$/i.test(String(v)));
const num = (v, dflt) => (v === undefined || v === '' ? dflt : Number(v));

export const config = {
  port: num(process.env.PORT, 3737),

  smtp: {
    host: process.env.SMTP_HOST || '',
    port: num(process.env.SMTP_PORT, 587),
    secure: bool(process.env.SMTP_SECURE, num(process.env.SMTP_PORT, 587) === 465),
    user: process.env.SMTP_USER || '',
    pass: process.env.SMTP_PASS || '',
  },

  from: {
    name: process.env.FROM_NAME || process.env.MY_NAME || '',
    email: process.env.FROM_EMAIL || process.env.SMTP_USER || '',
  },
  replyTo: process.env.REPLY_TO || '',
  bccSelf: bool(process.env.BCC_SELF, false),

  // Throttling. Sending 50 messages in 5 seconds from a personal mailbox is the
  // fastest way to get rate-limited or spam-foldered; these defaults are gentle.
  throttle: {
    delayMs: num(process.env.SEND_DELAY_MS, 8000),
    jitterMs: num(process.env.SEND_JITTER_MS, 4000),
    dailyCap: num(process.env.DAILY_CAP, 40),
    batchCap: num(process.env.BATCH_CAP, 25),
  },

  attachmentsDir: path.resolve(process.env.ATTACHMENTS_DIR || 'attachments'),
  defaultAttachments: (process.env.DEFAULT_ATTACHMENTS || '')
    .split(',').map((s) => s.trim()).filter(Boolean),

  // Merge-field defaults, injected into every render as {{my_*}}.
  me: {
    myName: process.env.MY_NAME || '',
    myEmail: process.env.MY_EMAIL || process.env.FROM_EMAIL || '',
    myPhone: process.env.MY_PHONE || '',
    myLinkedin: process.env.MY_LINKEDIN || '',
    myGithub: process.env.MY_GITHUB || '',
    myLocation: process.env.MY_LOCATION || '',
  },

  fallbackGreeting: process.env.FALLBACK_GREETING || 'Hiring Team',
  defaultRole: process.env.DEFAULT_ROLE || '',
};

export function smtpConfigured() {
  const { host, user, pass } = config.smtp;
  return Boolean(host && user && pass);
}

/** Browser-safe view: no password, ever. */
export function publicConfig() {
  return {
    smtpConfigured: smtpConfigured(),
    smtpHost: config.smtp.host,
    smtpUser: config.smtp.user,
    from: config.from,
    replyTo: config.replyTo,
    bccSelf: config.bccSelf,
    throttle: config.throttle,
    me: config.me,
    fallbackGreeting: config.fallbackGreeting,
    defaultRole: config.defaultRole,
    defaultAttachments: config.defaultAttachments,
  };
}

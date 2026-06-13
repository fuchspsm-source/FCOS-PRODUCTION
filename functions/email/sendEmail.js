const { Resend } = require('resend');
const { defineSecret } = require('firebase-functions/params');
const logger = require('firebase-functions/logger');

const RESEND_API_KEY = defineSecret('RESEND_API_KEY');

async function sendEmail({ to, subject, html }) {
  if (!to || !subject || !html) {
    return { error: 'Missing required fields: to, subject, html' };
  }
  if (!to.includes('@')) {
    return { error: 'Invalid email address' };
  }

  let apiKey;
  try {
    apiKey = RESEND_API_KEY.value();
  } catch (err) {
    logger.error('EML-1A: RESEND_API_KEY not bound to this function', err);
    return { error: 'Email configuration missing: RESEND_API_KEY not bound' };
  }

  if (!apiKey) {
    return { error: 'Email configuration missing: RESEND_API_KEY empty' };
  }

  const resend = new Resend(apiKey);

  try {
    const { data, error } = await resend.emails.send({
      from: 'PSM - Fuchs Lubricants Indonesia - System <onboarding@resend.dev>',
      to: [to],
      subject,
      html,
    });

    if (error) {
      logger.error('EML-1A: Resend rejected payload', error);
      return { error: error.message || 'Resend send failed' };
    }

    logger.info(`EML-1A: Email sent. Message ID: ${data.id}`);
    return { ok: true, message_id: data.id };
  } catch (err) {
    logger.error('EML-1A: Critical dispatch failure', err);
    return { error: `Email send failed: ${err.message}` };
  }
}

module.exports = { sendEmail, RESEND_API_KEY };

'use strict';
// Sends the sign-in code. In Azure: Azure Communication Services Email.
// In development: prints the code to the console (never allowed in Azure, see config.js).

function codeMessage(code, minutes) {
  const subject = `ENGAGE sign-in code: ${code}`;
  const plainText = `Your ENGAGE sign-in code is ${code}.\n\nIt works once and expires in ${minutes} minutes.\nIf you did not ask for it, you can ignore this email.`;
  const html = `<p>Your ENGAGE sign-in code is</p><p style="font-size:24px;font-weight:700;letter-spacing:4px">${code}</p><p>It works once and expires in ${minutes} minutes. If you did not ask for it, you can ignore this email.</p>`;
  return { subject, plainText, html };
}

function makeMailer(cfg, log = console) {
  if (cfg.devPrint) {
    return {
      sent: [],
      async send(to, code) { this.sent.push({ to, code }); log.info ? log.info(`[dev] sign-in code for ${to}: ${code}`) : log.log(`[dev] sign-in code for ${to}: ${code}`); },
    };
  }
  const { EmailClient } = require('@azure/communication-email');
  const client = new EmailClient(cfg.acsConnection);
  return {
    async send(to, code) {
      const m = codeMessage(code, Math.round(cfg.codeTtlMs / 60000));
      const poller = await client.beginSend({ senderAddress: cfg.acsSender, recipients: { to: [{ address: to }] }, content: m });
      await poller.pollUntilDone();
    },
  };
}

module.exports = { makeMailer, codeMessage };

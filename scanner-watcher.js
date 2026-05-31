const { ImapFlow } = require('imapflow');
const { simpleParser } = require('mailparser');
const nodemailer = require('nodemailer');
const Anthropic = require('@anthropic-ai/sdk');

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const IMAP_CONFIG = {
  host: process.env.IMAP_HOST || 'imap.gmail.com',
  port: parseInt(process.env.IMAP_PORT) || 993,
  secure: true,
  auth: {
    user: process.env.IMAP_USER,
    pass: process.env.IMAP_PASS,
  },
  logger: false,
};

// Nur E-Mails von dieser Domain werden verarbeitet
const ALLOWED_DOMAIN = process.env.ALLOWED_DOMAIN || 'schweizer-finanz.de';

// Scanner-Adresse: Antwort geht NICHT zurück an den Drucker, sondern an NOTIFY_EMAIL
const SCANNER_EMAIL = (process.env.SCANNER_EMAIL || 'scanner@schweizer-finanz.de').toLowerCase();
const NOTIFY_EMAIL = process.env.NOTIFY_EMAIL || 'post@schweizer-finanz.de';

async function analyseDocument(pdfBuffer) {
  const response = await anthropic.messages.create({
    model: 'claude-opus-4-8',
    max_tokens: 768,
    messages: [{
      role: 'user',
      content: [
        {
          type: 'document',
          source: { type: 'base64', media_type: 'application/pdf', data: pdfBuffer.toString('base64') }
        },
        {
          type: 'text',
          text: `Du bist ein Dokumenten-Assistent für das Finanzdienstleistungsbüro Schweizer Finanz.
Analysiere dieses eingescannte Dokument und erstelle:
1. Einen Dateinamen nach unserem internen Schema
2. Eine kurze Zusammenfassung (2-4 Sätze) des Inhalts auf Deutsch

Pflichtformat: JJJJ-MM-TT_Kunde_Betreff_Status (ohne .pdf)

Felder:
- Datum (JJJJ-MM-TT): Datum aus dem Dokument. Falls kein Datum erkennbar, weglassen.
- Kunde: Nachname_Vorname des Kunden oder Absenders. Bei Firmen: Firmenname. Kein Komma, Leerzeichen durch Unterstrich.
- Betreff: Worum geht es? (z.B. Stromrechnung, Maklervollmacht, PKV-Angebot, Kuendigungsschreiben)
- Status (optional): Nur wenn eindeutig erkennbar (z.B. ENTWURF, UNTERSCHRIEBEN, MAHNUNG). Sonst weglassen.

Regeln:
- Nur Unterstriche statt Leerzeichen
- Keine Sonderzeichen außer Bindestrich und Unterstrich
- Umlaute: ä→ae, ö→oe, ü→ue, ß→ss

Beispiele:
- 2024-08-15_Mustermann_Max_PKV-Angebot
- 2024-03-01_Allianz_Kuendigung_UNTERSCHRIEBEN
- Meier_GmbH_Maklervollmacht_ENTWURF

Antworte NUR als JSON:
{"filename": "...", "summary": "Kurze Zusammenfassung...", "reasoning": "Kurze Begründung"}`
        }
      ]
    }]
  });

  try {
    const match = response.content[0].text.match(/\{[\s\S]*\}/);
    const result = JSON.parse(match ? match[0] : response.content[0].text);
    return result;
  } catch {
    return {
      filename: 'Scan_' + new Date().toISOString().slice(0, 10),
      summary: 'Inhalt konnte nicht automatisch erkannt werden.',
      reasoning: 'Analyse fehlgeschlagen.'
    };
  }
}

function createTransporter() {
  return nodemailer.createTransport({
    host: process.env.SMTP_HOST || 'smtp.gmail.com',
    port: 587,
    secure: false,
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
  });
}

async function sendResult({ pdfBuffer, filename, summary, reasoning, replyTo }) {
  const transporter = createTransporter();
  const finalName = filename.endsWith('.pdf') ? filename : filename + '.pdf';

  await transporter.sendMail({
    from: process.env.SMTP_USER,
    to: replyTo,
    subject: `📄 ${finalName}`,
    text: [
      `Anbei das automatisch umbenannte Dokument.`,
      ``,
      `Dateiname: ${finalName}`,
      ``,
      `Zusammenfassung:`,
      summary,
      ``,
      `Empfangen: ${new Date().toLocaleString('de-DE')}`,
    ].join('\n'),
    attachments: [{
      filename: finalName,
      content: pdfBuffer,
      contentType: 'application/pdf',
    }],
  });

  console.log(`[Scanner] Gesendet: ${finalName} → ${replyTo}`);
}

async function processNewEmails(client) {
  const messages = [];
  for await (const msg of client.fetch('UNSEEN', { source: true, envelope: true })) {
    messages.push(msg);
  }

  for (const msg of messages) {
    let parsed;
    try {
      parsed = await simpleParser(msg.source);
    } catch (e) {
      console.error('[Scanner] E-Mail parsen fehlgeschlagen:', e.message);
      continue;
    }

    const senderAddress = (parsed.from?.value?.[0]?.address || '').toLowerCase();
    const senderDomain = senderAddress.split('@')[1] || '';

    // Sicherheitsfilter: nur @schweizer-finanz.de
    if (senderDomain !== ALLOWED_DOMAIN) {
      console.log(`[Scanner] Ignoriert (fremde Domain): ${senderAddress}`);
      await client.messageFlagsAdd(msg.seq, ['\\Seen']);
      continue;
    }

    const pdfs = (parsed.attachments || []).filter(a =>
      a.contentType === 'application/pdf' || a.filename?.toLowerCase().endsWith('.pdf')
    );

    if (pdfs.length === 0) {
      await client.messageFlagsAdd(msg.seq, ['\\Seen']);
      continue;
    }

    // Scanner-Adresse → Antwort an Büro-E-Mail, kein Rückversand an Drucker
    const isScanner = senderAddress === SCANNER_EMAIL;
    const replyTo = isScanner ? NOTIFY_EMAIL : senderAddress;

    console.log(`[Scanner] ${pdfs.length} PDF(s) von ${senderAddress} → Antwort an ${replyTo}`);

    for (const pdf of pdfs) {
      try {
        console.log(`[Scanner] Analysiere: ${pdf.filename || 'unbenannt.pdf'}`);
        const { filename, summary, reasoning } = await analyseDocument(pdf.content);
        console.log(`[Scanner] Name: ${filename}`);
        await sendResult({ pdfBuffer: pdf.content, filename, summary, reasoning, replyTo });
      } catch (e) {
        console.error(`[Scanner] Fehler bei PDF-Verarbeitung: ${e.message}`);
      }
    }

    await client.messageFlagsAdd(msg.seq, ['\\Seen']);
  }
}

async function startWatcher() {
  if (!process.env.IMAP_USER || !process.env.IMAP_PASS) {
    console.log('[Scanner] IMAP_USER / IMAP_PASS nicht gesetzt – Watcher deaktiviert.');
    return;
  }

  let backoff = 5000;

  while (true) {
    const client = new ImapFlow(IMAP_CONFIG);

    try {
      await client.connect();
      console.log(`[Scanner] Verbunden mit ${IMAP_CONFIG.host} als ${IMAP_CONFIG.auth.user}`);
      backoff = 5000;

      const lock = await client.getMailboxLock('INBOX');
      try {
        await processNewEmails(client);

        while (true) {
          console.log('[Scanner] Warte auf neue E-Mails (IDLE)...');
          await client.idle();
          await processNewEmails(client);
        }
      } finally {
        lock.release();
      }
    } catch (e) {
      console.error(`[Scanner] Verbindungsfehler: ${e.message}`);
      try { await client.logout(); } catch {}
    }

    console.log(`[Scanner] Reconnect in ${backoff / 1000}s...`);
    await new Promise(r => setTimeout(r, backoff));
    backoff = Math.min(backoff * 2, 60000);
  }
}

module.exports = { startWatcher };

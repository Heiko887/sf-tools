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

async function suggestFilename(pdfBuffer) {
  const response = await anthropic.messages.create({
    model: 'claude-opus-4-8',
    max_tokens: 512,
    messages: [{
      role: 'user',
      content: [
        {
          type: 'document',
          source: { type: 'base64', media_type: 'application/pdf', data: pdfBuffer.toString('base64') }
        },
        {
          type: 'text',
          text: `Du bist ein Dokumenten-Assistent für ein deutsches Finanzdienstleistungsbüro.
Analysiere dieses eingescannte Dokument und erstelle einen aussagekräftigen deutschen Dateinamen.

Regeln:
- Format: JJJJ-MM-TT_Name_Dokumenttyp_Thema (ohne .pdf)
- Datum aus dem Dokument, falls vorhanden, sonst weglassen
- Name = Absender, Kunde oder Institution
- Dokumenttyp = z.B. Rechnung, Vertrag, Brief, Bescheid, Antrag, Mahnung, Police, Kuendigung
- Thema = kurzes Stichwort (max. 2 Wörter)
- Nur Unterstriche statt Leerzeichen, keine Sonderzeichen
- Umlaute: ä→ae, ö→oe, ü→ue, ß→ss

Antworte NUR als JSON: {"filename": "...", "reasoning": "..."}`
        }
      ]
    }]
  });

  try {
    const match = response.content[0].text.match(/\{[\s\S]*\}/);
    const result = JSON.parse(match ? match[0] : response.content[0].text);
    return result;
  } catch {
    return { filename: 'Scan_' + new Date().toISOString().slice(0, 10), reasoning: 'Inhalt nicht eindeutig erkennbar.' };
  }
}

async function forwardRenamed(pdfBuffer, filename, reasoning, originalFrom) {
  const transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST || 'smtp.gmail.com',
    port: 587,
    secure: false,
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
  });

  const recipient = process.env.NOTIFY_EMAIL || 'post@schweizer-finanz.de';
  const finalName = filename.endsWith('.pdf') ? filename : filename + '.pdf';

  await transporter.sendMail({
    from: process.env.SMTP_USER,
    to: recipient,
    subject: `📄 Scanner: ${finalName}`,
    text: `Automatisch umbenanntes Scanner-Dokument.\n\nDateiname: ${finalName}\nGrund: ${reasoning}\nOriginal-Absender: ${originalFrom || 'Scanner'}\nEmpfangen: ${new Date().toLocaleString('de-DE')}`,
    attachments: [{
      filename: finalName,
      content: pdfBuffer,
      contentType: 'application/pdf',
    }],
  });

  console.log(`[Scanner] Weitergeleitet: ${finalName} → ${recipient}`);
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

    const pdfs = (parsed.attachments || []).filter(a =>
      a.contentType === 'application/pdf' || a.filename?.toLowerCase().endsWith('.pdf')
    );

    if (pdfs.length === 0) {
      // Kein PDF – als gelesen markieren und überspringen
      await client.messageFlagsAdd(msg.seq, ['\\Seen']);
      continue;
    }

    console.log(`[Scanner] ${pdfs.length} PDF(s) in E-Mail von: ${parsed.from?.text || 'unbekannt'}`);

    for (const pdf of pdfs) {
      try {
        console.log(`[Scanner] Analysiere: ${pdf.filename || 'unbenannt.pdf'}`);
        const { filename, reasoning } = await suggestFilename(pdf.content);
        console.log(`[Scanner] Vorgeschlagener Name: ${filename} – ${reasoning}`);
        await forwardRenamed(pdf.content, filename, reasoning, parsed.from?.text);
      } catch (e) {
        console.error(`[Scanner] Fehler bei PDF-Verarbeitung: ${e.message}`);
      }
    }

    await client.messageFlagsAdd(msg.seq, ['\\Seen']);
  }
}

async function startWatcher() {
  // Konfiguration prüfen
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
        // Beim Start vorhandene ungelesene E-Mails verarbeiten
        await processNewEmails(client);

        // IMAP IDLE: blockiert bis neue E-Mail eintrifft
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
    backoff = Math.min(backoff * 2, 60000); // max. 60s Wartezeit
  }
}

module.exports = { startWatcher };

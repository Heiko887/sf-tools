const express = require('express');
const multer = require('multer');
const nodemailer = require('nodemailer');
const Anthropic = require('@anthropic-ai/sdk');
const { v4: uuidv4 } = require('uuid');
const path = require('path');
const fs = require('fs');
const { startWatcher } = require('./scanner-watcher');

const app = express();
const upload = multer({ dest: 'uploads/' });
const PORT = process.env.PORT || 3000;
const NOTIFY_EMAIL = process.env.NOTIFY_EMAIL || 'post@schweizer-finanz.de';
const BASE_URL = process.env.BASE_URL || 'http://localhost:3000';
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

app.use(express.json({ limit: '50mb' }));
app.use(express.static('public'));

const sessions = {};
if (!fs.existsSync('uploads')) fs.mkdirSync('uploads');
if (!fs.existsSync('signed')) fs.mkdirSync('signed');

app.post('/api/upload', upload.single('pdf'), (req, res) => {
  const id = uuidv4();
  const { clientName, clientEmail, message } = req.body;
  sessions[id] = {
    id, clientName, clientEmail, message,
    pdfPath: req.file.path,
    originalName: req.file.originalname,
    createdAt: new Date(),
    signed: false
  };
  const link = `${BASE_URL}/sign/${id}`;
  res.json({ success: true, link, id });
});

app.get('/sign/:id', (req, res) => {
  const session = sessions[req.params.id];
  if (!session) return res.status(404).send('Link ungültig oder abgelaufen.');
  if (session.signed) return res.send('<h2>Dieses Dokument wurde bereits unterzeichnet.</h2>');
  res.sendFile(path.join(__dirname, 'public', 'sign.html'));
});

app.get('/api/session/:id', (req, res) => {
  const session = sessions[req.params.id];
  if (!session) return res.status(404).json({ error: 'Not found' });
  res.json({ clientName: session.clientName, message: session.message, originalName: session.originalName });
});

app.get('/api/pdf/:id', (req, res) => {
  const session = sessions[req.params.id];
  if (!session) return res.status(404).send('Not found');
  res.sendFile(path.join(__dirname, session.pdfPath));
});

app.post('/api/sign/:id', express.json({ limit: '50mb' }), async (req, res) => {
  const session = sessions[req.params.id];
  if (!session) return res.status(404).json({ error: 'Not found' });
  const { signedPdfBase64, signerName, signerCity } = req.body;
  const buf = Buffer.from(signedPdfBase64, 'base64');
  const signedPath = `signed/${req.params.id}.pdf`;
  fs.writeFileSync(signedPath, buf);
  session.signed = true;
  session.signedAt = new Date();
  session.signerName = signerName;

  try {
    const transporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST || 'smtp.gmail.com',
      port: 587, secure: false,
      auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
    });
    await transporter.sendMail({
      from: process.env.SMTP_USER,
      to: NOTIFY_EMAIL,
      subject: `✅ Unterschrift erhalten – ${signerName || session.clientName}`,
      text: `Das Dokument "${session.originalName}" wurde von ${signerName || session.clientName} (${signerCity || ''}) unterzeichnet.\n\nDatum: ${new Date().toLocaleString('de-DE')}`,
      attachments: [{ filename: `Unterzeichnet_${session.originalName}`, path: signedPath }]
    });
  } catch(e) { console.error('E-Mail Fehler:', e.message); }

  res.json({ success: true });
});

// Scanner: PDF analysieren und Dateinamen vorschlagen
app.post('/api/scan-rename', upload.single('pdf'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Keine PDF-Datei empfangen.' });
  try {
    const pdfBuffer = fs.readFileSync(req.file.path);
    const pdfBase64 = pdfBuffer.toString('base64');

    const response = await anthropic.messages.create({
      model: 'claude-opus-4-8',
      max_tokens: 512,
      messages: [{
        role: 'user',
        content: [
          {
            type: 'document',
            source: { type: 'base64', media_type: 'application/pdf', data: pdfBase64 }
          },
          {
            type: 'text',
            text: `Du bist ein Dokumenten-Assistent für ein deutsches Finanzdienstleistungsbüro.
Analysiere dieses eingescannte Dokument und erstelle einen aussagekräftigen deutschen Dateinamen.

Regeln für den Dateinamen:
- Format: JJJJ-MM-TT_Name_Dokumenttyp_Thema (ohne .pdf am Ende)
- Datum aus dem Dokument verwenden, falls vorhanden (sonst weglassen)
- Name = Absender, Kunde oder Institution
- Dokumenttyp = z.B. Rechnung, Vertrag, Brief, Bescheid, Antrag, Mahnung, Police, Kündigung
- Thema = kurzes Stichwort zum Inhalt (max. 2 Wörter)
- Keine Leerzeichen, stattdessen Unterstriche
- Keine Sonderzeichen außer Bindestrich und Unterstrich
- Umlaute ersetzen: ä→ae, ö→oe, ü→ue, ß→ss

Antworte NUR im JSON-Format:
{"filename": "2024-01-15_Mustermann_Rechnung_Krankenversicherung", "reasoning": "Kurze Erklärung warum dieser Name"}`
          }
        ]
      }]
    });

    fs.unlinkSync(req.file.path);

    let result;
    try {
      const jsonMatch = response.content[0].text.match(/\{[\s\S]*\}/);
      result = JSON.parse(jsonMatch ? jsonMatch[0] : response.content[0].text);
    } catch {
      result = { filename: 'Dokument_' + Date.now(), reasoning: 'Inhalt konnte nicht eindeutig erkannt werden.' };
    }

    if (!result.filename.endsWith('.pdf')) result.filename = result.filename + '.pdf';
    res.json(result);
  } catch (e) {
    if (req.file?.path) fs.unlink(req.file.path, () => {});
    console.error('Scan-Rename Fehler:', e.message);
    res.status(500).json({ error: 'KI-Analyse fehlgeschlagen: ' + e.message });
  }
});

// Scanner: Umbenanntes PDF per E-Mail weiterleiten
app.post('/api/scan-forward', express.json({ limit: '50mb' }), async (req, res) => {
  const { pdfBase64, filename, emailTo } = req.body;
  if (!pdfBase64 || !filename) return res.status(400).json({ error: 'PDF und Dateiname erforderlich.' });

  const recipient = emailTo && emailTo.trim() ? emailTo.trim() : NOTIFY_EMAIL;

  try {
    const transporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST || 'smtp.gmail.com',
      port: 587, secure: false,
      auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
    });
    await transporter.sendMail({
      from: process.env.SMTP_USER,
      to: recipient,
      subject: `📄 Scanner-Dokument: ${filename}`,
      text: `Anbei das eingescannte und automatisch benannte Dokument.\n\nDateiname: ${filename}\nErstellt: ${new Date().toLocaleString('de-DE')}`,
      attachments: [{
        filename,
        content: Buffer.from(pdfBase64, 'base64'),
        contentType: 'application/pdf'
      }]
    });
    res.json({ success: true });
  } catch (e) {
    console.error('E-Mail Fehler:', e.message);
    res.status(500).json({ error: 'E-Mail konnte nicht gesendet werden: ' + e.message });
  }
});

app.listen(PORT, () => {
  console.log(`SF Tools läuft auf Port ${PORT}`);
  startWatcher();
});

const express = require('express');
const multer = require('multer');
const nodemailer = require('nodemailer');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const { v4: uuidv4 } = require('uuid');
const path = require('path');
const fs = require('fs');
const { startWatcher } = require('./scanner-watcher');

const app = express();
const upload = multer({ dest: 'uploads/' });
const PORT = process.env.PORT || 3000;
const NOTIFY_EMAIL = process.env.NOTIFY_EMAIL || 'post@schweizer-finanz.de';
const BASE_URL = process.env.BASE_URL || 'http://localhost:3000';
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

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

    const model = genAI.getGenerativeModel({ model: 'gemini-1.5-flash' });
    const response = await model.generateContent([
      {
        inlineData: { data: pdfBase64, mimeType: 'application/pdf' }
      },
      `Du bist ein Dokumenten-Assistent für das Finanzdienstleistungsbüro Schweizer Finanz.
Analysiere dieses eingescannte Dokument und erstelle einen Dateinamen nach unserem internen Schema.

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

Antworte NUR als JSON (kein Markdown, kein Codeblock):
{"filename": "...", "reasoning": "Kurze Begründung"}`
    ]);

    fs.unlinkSync(req.file.path);

    let result;
    try {
      const text = response.response.text();
      const jsonMatch = text.match(/\{[\s\S]*\}/);
      result = JSON.parse(jsonMatch ? jsonMatch[0] : text);
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

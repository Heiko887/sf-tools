const express = require('express');
const multer = require('multer');
const nodemailer = require('nodemailer');
const { v4: uuidv4 } = require('uuid');
const path = require('path');
const fs = require('fs');

const app = express();
const upload = multer({ dest: 'uploads/' });
const PORT = process.env.PORT || 3000;
const NOTIFY_EMAIL = process.env.NOTIFY_EMAIL || 'post@schweizer-finanz.de';
const BASE_URL = process.env.BASE_URL || 'http://localhost:3000';

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

app.listen(PORT, () => console.log(`SF Tools läuft auf Port ${PORT}`));

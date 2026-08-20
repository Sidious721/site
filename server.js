require('dotenv').config();
const express = require('express');
const cors = require('cors');
const multer = require('multer');
const nodemailer = require('nodemailer');

const app = express();
const PORT = process.env.PORT || 3000;
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || '*';
const RFQ_TO_EMAIL = process.env.RFQ_TO_EMAIL || 'logiq.freight@outlook.com';

app.use(cors({ origin: ALLOWED_ORIGIN }));

// Файл храним в памяти (не пишем на диск) и сразу прикладываем к письму
const ALLOWED_EXTENSIONS = ['pdf', 'jpg', 'jpeg', 'png', 'xlsx', 'xls', 'doc', 'docx'];
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 }, // 10 МБ — как заявлено на сайте
  fileFilter: (req, file, cb) => {
    const ext = (file.originalname.split('.').pop() || '').toLowerCase();
    if (!ALLOWED_EXTENSIONS.includes(ext)) {
      return cb(new Error('unsupported_file_type'));
    }
    cb(null, true);
  },
});

const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST,
  port: Number(process.env.SMTP_PORT) || 587,
  secure: process.env.SMTP_SECURE === 'true', // true для 465, false для 587 (STARTTLS)
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS,
  },
});

function field(v) {
  if (v === undefined || v === null || String(v).trim() === '') return '—';
  return String(v).trim();
}

function isChecked(v) {
  // чекбоксы приходят как "on", "true" либо отсутствуют вовсе
  return v === 'on' || v === 'true' || v === true;
}

app.post('/api/rfq', (req, res) => {
  upload.single('qFile')(req, res, async (err) => {
    if (err) {
      const reason = err.message === 'unsupported_file_type' ? 'unsupported_file_type' : 'upload_error';
      return res.status(400).json({ ok: false, error: reason });
    }

    try {
      const b = req.body;

      // Honeypot: если скрытое поле заполнено ботом — молча "успех", письмо не шлём
      if (b.company_website) {
        return res.status(200).json({ ok: true });
      }

      // Серверная валидация обязательных полей (дублирует клиентскую — доверять клиенту нельзя)
      const requiredMissing = ['qFrom', 'qTo', 'qName', 'qContact'].filter(
        (key) => !b[key] || !String(b[key]).trim()
      );
      if (requiredMissing.length) {
        return res.status(400).json({ ok: false, error: 'missing_required_fields', fields: requiredMissing });
      }
      if (!isChecked(b.qConsent)) {
        return res.status(400).json({ ok: false, error: 'consent_required' });
      }

      const lines = [
        `Откуда: ${field(b.qFrom)}`,
        `Куда: ${field(b.qTo)}`,
        `Вес, кг: ${field(b.qWeight)}`,
        `Объём, м³: ${field(b.qVolume)}`,
        '',
        `Имя: ${field(b.qName)}`,
        `Контакт: ${field(b.qContact)}`,
        '',
        `Груз: ${field(b.qCargo)}`,
        `Количество мест: ${field(b.qPieces)}`,
        `Размеры мест: ${field(b.qDims)}`,
        `Стоимость товара: ${field(b.qValue)}`,
        `Дата готовности: ${field(b.qReady)}`,
        `Incoterms: ${field(b.qIncoterms)}`,
        '',
        `Аккумуляторы/жидкости/опасные компоненты: ${isChecked(b.qBattery) ? 'да' : 'нет'}`,
        `Брендированный товар: ${isChecked(b.qBranded) ? 'да' : 'нет'}`,
        `Нужен забор у поставщика: ${isChecked(b.qPickup) ? 'да' : 'нет'}`,
        `Нужно таможенное сопровождение: ${isChecked(b.qCustoms) ? 'да' : 'нет'}`,
        `Нужна оплата поставщику: ${isChecked(b.qPayment) ? 'да' : 'нет'}`,
        '',
        `Комментарий: ${field(b.qComment)}`,
        '',
        `Файл приложен: ${req.file ? 'да (' + req.file.originalname + ')' : 'нет'}`,
      ];

      const replyTo = String(b.qContact || '').includes('@') ? b.qContact : undefined;

      const mailOptions = {
        from: `"LogiQ — заявки с сайта" <${process.env.SMTP_USER}>`,
        to: RFQ_TO_EMAIL,
        replyTo,
        subject: `Заявка с сайта: ${field(b.qFrom)} → ${field(b.qTo)} (${field(b.qName)})`,
        text: lines.join('\n'),
        attachments: req.file
          ? [{ filename: req.file.originalname, content: req.file.buffer }]
          : [],
      };

      await transporter.sendMail(mailOptions);

      return res.status(200).json({ ok: true });
    } catch (mailErr) {
      console.error('RFQ send error:', mailErr);
      return res.status(500).json({ ok: false, error: 'server_error' });
    }
  });
});

app.get('/health', (req, res) => res.json({ ok: true }));

app.listen(PORT, () => {
  console.log(`LogiQ RFQ backend слушает порт ${PORT}`);
});

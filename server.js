require('dotenv').config();
const express = require('express');
const cors = require('cors');
const multer = require('multer');

const app = express();
const PORT = process.env.PORT || 3000;
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || '*';
const RFQ_TO_EMAIL = process.env.RFQ_TO_EMAIL || 'a.egorov@logiq-freight.com';

// ВАЖНО: письма отправляются через HTTP API Resend (api.resend.com), а НЕ через
// прямой SMTP. Причина: у бесплатных тарифов большинства облачных хостингов
// (в том числе Render, с сентября 2025) исходящий SMTP-трафик (порты 25/465/587)
// заблокирован на уровне платформы ради борьбы со спамом — с любыми, даже
// полностью верными данными, письмо через прямой SMTP оттуда física не уйдёт,
// соединение будет просто "молча висеть". HTTP API работает через порт 443
// (обычный HTTPS), который никто не блокирует.
const RESEND_API_KEY = process.env.RESEND_API_KEY;
// До подтверждения собственного домена в Resend можно слать с их тестового
// адреса onboarding@resend.dev — это ограничение только на адрес ОТПРАВИТЕЛЯ,
// присылать письма можно на любой РЕАЛЬНЫЙ адрес получателя без ограничений.
const FROM_EMAIL = process.env.FROM_EMAIL || 'LogiQ — заявки с сайта <onboarding@resend.dev>';

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

// Отправка через Resend HTTP API с собственным тайм-аутом — если Resend вдруг
// не ответит, backend не зависнет молча, а вернёт понятную ошибку через 20 сек.
async function sendMailViaResend({ to, from, replyTo, subject, text, attachments }, timeoutMs) {
  if (!RESEND_API_KEY) {
    throw new Error('resend_not_configured');
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${RESEND_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from,
        to: [to],
        reply_to: replyTo,
        subject,
        text,
        attachments,
      }),
      signal: controller.signal,
    });

    const data = await res.json().catch(() => ({}));

    if (!res.ok) {
      const err = new Error(data.message || 'resend_api_error');
      err.status = res.status;
      throw err;
    }

    return data;
  } catch (err) {
    if (err.name === 'AbortError') {
      throw new Error('resend_timeout');
    }
    throw err;
  } finally {
    clearTimeout(timeoutId);
  }
}

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

      const attachments = req.file
        ? [{ filename: req.file.originalname, content: req.file.buffer.toString('base64') }]
        : [];

      await sendMailViaResend({
        to: RFQ_TO_EMAIL,
        from: FROM_EMAIL,
        replyTo,
        subject: `Заявка с сайта: ${field(b.qFrom)} → ${field(b.qTo)} (${field(b.qName)})`,
        text: lines.join('\n'),
        attachments,
      }, 20000);

      return res.status(200).json({ ok: true });
    } catch (mailErr) {
      console.error('RFQ send error:', mailErr);
      const isTimeout = mailErr.message === 'resend_timeout';
      const notConfigured = mailErr.message === 'resend_not_configured';
      return res.status(isTimeout ? 504 : 500).json({
        ok: false,
        error: notConfigured ? 'resend_not_configured' : (isTimeout ? 'resend_timeout' : 'server_error'),
      });
    }
  });
});

app.get('/health', (req, res) => res.json({ ok: true }));

app.listen(PORT, () => {
  console.log(`LogiQ RFQ backend слушает порт ${PORT}`);
});

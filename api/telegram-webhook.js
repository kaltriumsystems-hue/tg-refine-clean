// /api/telegram-webhook.js
export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(200).json({ ok: true, hint: 'POST only' });
  }

  const TG_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
  if (!TG_TOKEN) return res.status(500).json({ ok: false, error: 'Missing TELEGRAM_BOT_TOKEN' });
  const TG_API = `https://api.telegram.org/bot${TG_TOKEN}`;

  const update = req.body || {};
  const chatId =
    update?.message?.chat?.id ??
    update?.edited_message?.chat?.id ??
    update?.callback_query?.message?.chat?.id;

  async function tgSendMessage(text) {
    try {
      await fetch(`${TG_API}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, text }),
      });
    } catch (_) {}
  }

  // Нет chatId — просто подтверждаем вебхук
  if (!chatId) return res.status(200).json({ ok: true, note: 'no chat id in update' });

  try {
    // 1) Текстовые сообщения — для проверки контура просто отвечаем
    const text = update?.message?.text ?? update?.edited_message?.text;
    if (typeof text === 'string' && text.trim()) {
      await tgSendMessage(`✅ Принято. Вы прислали: «${text.slice(0, 80)}»`);
      return res.status(200).json({ ok: true, kind: 'text' });
    }

    // 2) PDF — скачиваем как бинарь и пробуем извлечь текст (без pdfjs-dist)
    const doc = update?.message?.document;
    const isPDF =
      doc &&
      ((doc.mime_type && doc.mime_type.toLowerCase().includes('pdf')) ||
        (doc.file_name && doc.file_name.toLowerCase().endsWith('.pdf')));

    if (isPDF) {
      await tgSendMessage('📄 Файл получен, извлекаю текст…');

      // получить file_path
      const fileMeta = await fetch(`${TG_API}/getFile`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ file_id: doc.file_id }),
      }).then(r => r.json());

      const filePath = fileMeta?.result?.file_path;
      if (!filePath) {
        await tgSendMessage('❗️Ошибка: Telegram не вернул file_path.');
        return res.status(200).json({ ok: false, error: 'no file_path' });
      }

      // скачать бинарь
      const fileUrl = `https://api.telegram.org/file/bot${TG_TOKEN}/${filePath}`;
      const ab = await fetch(fileUrl).then(r => r.arrayBuffer());
      const buffer = Buffer.from(ab);

      // динамический импорт pdf-parse (ESM-friendly)
      const pdfModule = await import('pdf-parse');
      const pdfParse = pdfModule.default || pdfModule;

      let extracted = '';
      try {
        const parsed = await pdfParse(buffer);
        extracted = String(parsed?.text || '').replace(/\u0000/g, '').trim();
      } catch (e) {
        await tgSendMessage(`⚠️ Не удалось извлечь текст из PDF: ${e.message || e}`);
        return res.status(200).json({ ok: false, error: 'pdf-parse failed' });
      }

      if (!extracted) {
        await tgSendMessage('⚠️ В PDF не найден извлекаемый текст (возможно скан).');
        return res.status(200).json({ ok: true, kind: 'pdf-empty' });
      }

      const words = (extracted.match(/\S+/g) || []).length;
      await tgSendMessage(`✅ Текст извлечён. Слов: ~${words}. (Smoke-test пройден)`);
      return res.status(200).json({ ok: true, kind: 'pdf', words });
    }

    // Иное — игнорируем в smoke-тесте
    await tgSendMessage('ℹ️ Пришлите текст или PDF-файл.');
    return res.status(200).json({ ok: true, kind: 'other' });
  } catch (e) {
    await tgSendMessage(`❌ Ошибка обработчика: ${e.message || e}`);
    return res.status(200).json({ ok: false, error: String(e) });
  }
}

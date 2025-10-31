// /api/telegram-webhook.js
import { refineText } from "../lib/openai.js";
import { extractTextFromPDF } from "../lib/pdf.js";

const TG_API = (t) => `https://api.telegram.org/bot${t}`;

async function tgSend(chatId, text) {
  await fetch(`${TG_API(process.env.TELEGRAM_BOT_TOKEN)}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text })
  });
}

async function tgSendDoc(chatId, buffer, filename = "proofreader_report.txt") {
  const form = new FormData();
  form.append("chat_id", String(chatId));
  form.append("document", new Blob([buffer], { type: "text/plain" }), filename);
  await fetch(`${TG_API(process.env.TELEGRAM_BOT_TOKEN)}/sendDocument`, {
    method: "POST",
    body: form
  });
}

async function downloadTelegramFile(fileId) {
  // 1) получаем путь
  const r1 = await fetch(`${TG_API(process.env.TELEGRAM_BOT_TOKEN)}/getFile`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ file_id: fileId })
  });
  const p1 = await r1.json();
  const path = p1?.result?.file_path;
  if (!path) throw new Error("File path not returned by Telegram");

  // 2) качаем бинарь
  const url = `https://api.telegram.org/file/bot${process.env.TELEGRAM_BOT_TOKEN}/${path}`;
  const r2 = await fetch(url);
  if (!r2.ok) throw new Error(`Download failed: ${r2.status}`);
  const ab = await r2.arrayBuffer();
  return Buffer.from(ab); // pdf-parse ждёт Buffer
}

export default async function handler(req, res) {
  try {
    const update = req.body || {};
    const msg = update.message || update.edited_message;
    const chatId = msg?.chat?.id;

    // нет сообщения — просто 200
    if (!chatId) return res.status(200).json({ ok: true });

    const doc = msg.document;
    const text = msg.text;

    // === PDF-документ ===
    if (doc && (doc.mime_type?.includes("pdf") || doc.file_name?.toLowerCase().endsWith(".pdf"))) {
      await tgSend(chatId, "Файл получен, извлекаю текст…");
      try {
        const buf = await downloadTelegramFile(doc.file_id);
        const original = await extractTextFromPDF(buf);

        if (!original) {
          await tgSend(chatId, "Не удалось извлечь текст из PDF (возможно, скан/изображение).");
          return res.status(200).json({ ok: true });
        }

        // ограничим на старте до ~1500 слов
        const words = (original.match(/\S+/g) || []).length;
        if (words > 1500) {
          await tgSend(chatId, "В PDF >1500 слов. Раздели документ и пришли частями, пожалуйста.");
          return res.status(200).json({ ok: true });
        }

        const refined = await refineText(original);

        // выдаём как документ .txt (надёжно и быстро). PDF добавим на следующем шаге
        const report =
`— ORIGINAL —
${original}

— REFINED —
${refined}`;

        await tgSendDoc(chatId, Buffer.from(report, "utf8"), "proofreader_report.txt");
        return res.status(200).json({ ok: true });
      } catch (e) {
        await tgSend(chatId, `Ошибка обработки PDF: ${String(e.message || e)}`);
        return res.status(200).json({ ok: true });
      }
    }

    // === Обычный текст ===
    if (typeof text === "string" && text.trim()) {
      const src = text.replace(/^\/refine\s*/i, "").trim();
      if (!src) {
        await tgSend(chatId, "Отправь текст после /refine (например: “/refine Apple …”).");
        return res.status(200).json({ ok: true });
      }
      const words = (src.match(/\S+/g) || []).length;
      if (words > 1500) {
        await tgSend(chatId, "Текст >1500 слов. Раздели и пришли частями.");
        return res.status(200).json({ ok: true });
      }
      await tgSend(chatId, "Принято. Обрабатываю текст…");
      const refined = await refineText(src);
      await tgSend(chatId, refined || "(пустой ответ)");
      return res.status(200).json({ ok: true });
    }

    // другое (фото/стикеры) — игнор
    return res.status(200).json({ ok: true });
  } catch (e) {
    console.error(e);
    // Telegram важно получить 200
    return res.status(200).json({ ok: false, error: String(e) });
  }
}

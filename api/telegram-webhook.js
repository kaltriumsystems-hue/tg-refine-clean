// --- Импорты ---
import { OpenAI } from "openai";
import pdfParse from "pdf-parse";
import PDFDocument from "pdfkit";

// --- Конфигурация ---
export const config = {
  runtime: "nodejs",
};

// --- Клиенты и токены ---
const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_API = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}`;

// --- Универсальная отправка сообщений ---
async function tgSendMessage(chatId, text) {
  await fetch(`${TELEGRAM_API}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text }),
  });
}

// --- Отправка PDF-файла обратно в Telegram ---
async function tgSendDocument(chatId, pdfBuffer, filename = "proofreader_report.pdf", caption = "") {
  const buf = Buffer.isBuffer(pdfBuffer) ? pdfBuffer : Buffer.from(pdfBuffer);
  const form = new FormData();
  form.append("chat_id", String(chatId));
  if (caption) form.append("caption", caption);
  form.append("document", new Blob([buf], { type: "application/pdf" }), filename);

  const resp = await fetch(`${TELEGRAM_API}/sendDocument`, {
    method: "POST",
    body: form,
  });

  const text = await resp.text();
  if (!resp.ok) throw new Error(`TG sendDocument failed ${resp.status}: ${text}`);
  return text;
}

// --- Создание PDF из текста ---
function buildPdf(text) {
  return new Promise((resolve) => {
    const doc = new PDFDocument();
    const chunks = [];
    doc.on("data", (c) => chunks.push(c));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.fontSize(12).text(text);
    doc.end();
  });
}

// --- Основной обработчик ---
export default async function handler(req, res) {
  try {
    if (req.method !== "POST") {
      return res.status(200).json({ ok: true });
    }

    const body = req.body;
    if (!body.message) return res.status(200).json({ ok: true });

    const chatId = body.message.chat.id;

    // --- Если это файл PDF ---
    if (body.message.document && body.message.document.mime_type === "application/pdf") {
      await tgSendMessage(chatId, "📄 Файл получен, извлекаю текст...");

      const fileId = body.message.document.file_id;
      const fileRes = await fetch(`${TELEGRAM_API}/getFile?file_id=${fileId}`);
      const fileJson = await fileRes.json();
      const fileUrl = `https://api.telegram.org/file/bot${TELEGRAM_BOT_TOKEN}/${fileJson.result.file_path}`;

      const pdfBuffer = await (await fetch(fileUrl)).arrayBuffer();
      const parsed = await pdfParse(Buffer.from(pdfBuffer));

      if (!parsed.text.trim()) {
        await tgSendMessage(chatId, "⚠️ Не удалось извлечь текст из PDF (возможно, это скан).");
        return res.status(200).json({ ok: true });
      }

      await tgSendMessage(chatId, "✍️ Обрабатываю текст через редактор...");

      const completion = await client.chat.completions.create({
        model: "gpt-4o-mini",
        messages: [
          { role: "system", content: "You are a professional proofreader. Correct grammar and improve readability." },
          { role: "user", content: parsed.text },
        ],
      });

      const refined = completion.choices[0].message.content;
      const reportPdf = await buildPdf(refined);

      await tgSendDocument(chatId, reportPdf, "refined_text.pdf", "✅ Готово! Исправленный текст во вложении.");

      console.log("[TG] PDF обработан и отправлен ✅");
      return res.status(200).json({ ok: true });
    }

    // --- Если это обычное текстовое сообщение ---
    if (body.message.text) {
      const text = body.message.text.trim();

      if (text === "/start") {
        await tgSendMessage(chatId, "👋 Привет! Отправь PDF или текст для редактуры.");
        return res.status(200).json({ ok: true });
      }

      if (text.startsWith("/refine")) {
        const userText = text.replace("/refine", "").trim();
        if (!userText) {
          await tgSendMessage(chatId, "Пожалуйста, добавь текст после команды /refine.");
          return res.status(200).json({ ok: true });
        }

        await tgSendMessage(chatId, "✍️ Обрабатываю текст...");

        const completion = await client.chat.completions.create({
          model: "gpt-4o-mini",
          messages: [
            { role: "system", content: "You are a professional proofreader. Correct grammar and improve readability." },
            { role: "user", content: userText },
          ],
        });

        const refined = completion.choices[0].message.content;
        await tgSendMessage(chatId, refined);
        return res.status(200).json({ ok: true });
      }

      await tgSendMessage(chatId, "✅ Принято: " + text);
    }

    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error("Ошибка:", err);
    return res.status(500).json({ error: err.message });
  }
}




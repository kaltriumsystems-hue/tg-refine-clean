// Включаем Node.js runtime (иначе pdf-parse не сработает)
export const config = { runtime: "nodejs" };


// === Импорты ===
import fetch from "node-fetch";
import { OpenAI } from "openai";
import pdfParse from "pdf-parse";
import PDFDocument from "pdfkit";

// === Инициализация OpenAI ===
const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// === Telegram API ===
const TELEGRAM_API = `https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}`;

// Отправка текстового сообщения
async function tgSendMessage(chatId, text) {
  try {
    await fetch(`${TELEGRAM_API}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text }),
    });
  } catch (e) {
    console.error("[TG] sendMessage error:", e);
  }
}

// Отправка PDF-документа
async function tgSendDocument(chatId, buffer, filename = "report.pdf") {
  try {
    const formData = new FormData();
    formData.append("chat_id", chatId);
    formData.append("document", new Blob([buffer]), filename);

    await fetch(`${TELEGRAM_API}/sendDocument`, {
      method: "POST",
      body: formData,
    });
  } catch (e) {
    console.error("[TG] sendDocument error:", e);
  }
}

// Скачивание файла из Telegram
async function downloadTelegramFile(fileId) {
  const res = await fetch(`${TELEGRAM_API}/getFile?file_id=${fileId}`);
  const data = await res.json();
  if (!data.ok) throw new Error("Cannot get Telegram file path");
  const fileUrl = `https://api.telegram.org/file/bot${process.env.TELEGRAM_BOT_TOKEN}/${data.result.file_path}`;
  const fileRes = await fetch(fileUrl);
  return Buffer.from(await fileRes.arrayBuffer());
}

// Обработка текста через OpenAI
async function refine(text) {
  const prompt = `Proofread and slightly refine this text for clarity and style, preserving meaning:\n\n${text}`;
  const completion = await client.chat.completions.create({
    model: "gpt-4o-mini",
    messages: [{ role: "user", content: prompt }],
  });
  return { refined_text: completion.choices[0].message.content.trim() };
}

// Построение PDF-отчёта
async function buildPdfReport({ originalText, refinedText }) {
  return new Promise((resolve) => {
    const doc = new PDFDocument();
    const chunks = [];
    doc.on("data", (chunk) => chunks.push(chunk));
    doc.on("end", () => resolve(Buffer.concat(chunks)));

    doc.fontSize(16).text("Proofreading Report", { align: "center" });
    doc.moveDown();
    doc.fontSize(12).text("Original text:", { underline: true });
    doc.moveDown(0.5);
    doc.text(originalText);
    doc.addPage();
    doc.fontSize(12).text("Refined text:", { underline: true });
    doc.moveDown(0.5);
    doc.text(refinedText);
    doc.end();
  });
}

// === Основной обработчик ===
export default async function handler(req, res) {
  try {
    const update = req.body || (await req.json?.());
    console.log("[TG] update got");

    const msg = update?.message || update?.edited_message;
    const doc = msg?.document;

    // === PDF-файлы ===
    if (doc && (doc.mime_type?.includes("pdf") || doc.file_name?.endsWith(".pdf"))) {
      console.log("[TG] PDF branch start");
      await tgSendMessage(msg.chat.id, "Файл получен, извлекаю текст…");

      const bin = await downloadTelegramFile(doc.file_id);
      const parsed = await pdfParse(bin);
      const original = String(parsed?.text || "").replace(/\u0000/g, "").trim();

      if (!original) {
        await tgSendMessage(msg.chat.id, "Не удалось извлечь текст (возможно, это скан).");
        return res.status(200).json({ ok: true });
      }

      await tgSendMessage(msg.chat.id, "Обрабатываю текст через редактор…");
      const out = await refine(original);
      const pdf = await buildPdfReport({
        originalText: original,
        refinedText: out.refined_text,
      });

      await tgSendDocument(msg.chat.id, pdf, "proofreader_report.pdf");
      console.log("[TG] PDF обработан и отправлен ✅");
      return res.status(200).json({ ok: true });
    }

    // === Команда /refine ===
    const text = msg?.text;
    if (text?.startsWith("/refine")) {
      const content = text.replace("/refine", "").trim();
      await tgSendMessage(msg.chat.id, "Обрабатываю текст...");
      const out = await refine(content);
      await tgSendMessage(msg.chat.id, out.refined_text);
      return res.status(200).json({ ok: true });
    }

    // === Ping или другое ===
    if (text?.toLowerCase() === "ping") {
      await tgSendMessage(msg.chat.id, "✅ Принято: «ping»");
      return res.status(200).json({ ok: true });
    }

    return res.status(200).json({ ok: true });
  } catch (e) {
    console.error("[TG] handler error:", e);
    return res.status(200).json({ ok: false, error: String(e) });
  }
}



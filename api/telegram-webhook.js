// /api/telegram-webhook.js  (ESM)

import PDFDocument from "pdfkit";
import pdfParse from "pdf-parse";
import OpenAI from "openai";

const TG_TOKEN = process.env.TG_BOT_TOKEN;
const TG_API = `https://api.telegram.org/bot${TG_TOKEN}`;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

const ai = OPENAI_API_KEY ? new OpenAI({ apiKey: OPENAI_API_KEY }) : null;

// -- tiny utils
const countWords = (t) => (String(t || "").match(/\S+/g) || []).length;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function tgSendMessage(chatId, text) {
  try {
    await fetch(`${TG_API}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text }),
    });
  } catch { /* ignore */ }
}

async function tgSendDocument(chatId, buf, filename = "report.pdf") {
  const form = new FormData();
  form.append("chat_id", String(chatId));
  form.append("document", new Blob([buf], { type: "application/pdf" }), filename);

  await fetch(`${TG_API}/sendDocument`, { method: "POST", body: form });
}

async function downloadTelegramFile(file_id) {
  // 1) getFile -> { file_path }
  const get = await fetch(`${TG_API}/getFile`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ file_id }),
  });
  const j = await get.json();
  const path = j?.result?.file_path;
  if (!path) throw new Error("File path missing from Telegram API");

  // 2) fetch the file binary
  const url = `https://api.telegram.org/file/bot${TG_TOKEN}/${path}`;
  const binRes = await fetch(url);
  if (!binRes.ok) throw new Error(`Fetch file failed: ${binRes.status}`);
  const ab = await binRes.arrayBuffer();
  return new Uint8Array(ab);
}

async function extractTextFromPdf(uint8) {
  const parsed = await pdfParse(uint8);
  const text = String(parsed?.text || "")
    .replace(/\u0000/g, "")
    .replace(/[ \t]+/g, " ")
    .trim();
  return text;
}

async function refineTextWithAI(text) {
  if (!ai) return { refined: text, notes: "AI disabled (no OPENAI_API_KEY)" };

  const sys =
    "You are a professional copy editor. Fix grammar, clarity and tone. Keep original meaning. Keep length similar.";
  const user = `Edit the following text. Return ONLY the edited text.\n\n${text}`;

  const resp = await ai.responses.create({
    model: "gpt-4o-mini",
    input: [
      { role: "system", content: sys },
      { role: "user", content: user },
    ],
    temperature: 0.2,
  });

  const refined = resp?.output_text?.trim() || text;
  return { refined, notes: "" };
}

function buildPdfReport({ original, refined }) {
  return new Promise((resolve) => {
    const doc = new PDFDocument({ margin: 40, size: "A4" });
    const chunks = [];
    doc.on("data", (c) => chunks.push(c));
    doc.on("end", () => resolve(Buffer.concat(chunks)));

    doc.fontSize(16).text("Proofreader Report", { align: "center" });
    doc.moveDown();

    doc.fontSize(11).text("Original:", { underline: true });
    doc.moveDown(0.3);
    doc.fontSize(11).text(original || "(empty)");
    doc.moveDown();

    doc.fontSize(11).text("Refined:", { underline: true });
    doc.moveDown(0.3);
    doc.fontSize(11).text(refined || "(empty)");

    doc.end();
  });
}

export default async function handler(req, res) {
  try {
    if (req.method !== "POST") {
      return res.status(405).json({ ok: false, error: "Method Not Allowed" });
    }

    const update = req.body || {};
    const msg = update.message || update.edited_message;
    const chatId = msg?.chat?.id;
    const text = msg?.text;
    const doc = msg?.document;

    if (!chatId) return res.status(200).json({ ok: true });

    // command /ping — быстрый тест соединения
    if (String(text || "").trim().toLowerCase() === "ping") {
      await tgSendMessage(chatId, "✅ Принято: «ping»");
      return res.status(200).json({ ok: true });
    }

    // === PDF flow ===
    if (doc && (doc?.mime_type?.includes("pdf") || (doc?.file_name || "").toLowerCase().endsWith(".pdf"))) {
      await tgSendMessage(chatId, "Файл получен, извлекаю текст…");

      // 1) скачать PDF
      const bin = await downloadTelegramFile(doc.file_id);

      // 2) извлечь текст
      const original = await extractTextFromPdf(bin);
      if (!original) {
        await tgSendMessage(chatId, "Не удалось извлечь текст из PDF (возможно, скан).");
        return res.status(200).json({ ok: true });
      }

      // 3) лимит
      if (countWords(original) > 1100) {
        await tgSendMessage(chatId, "⚠️ В PDF >1100 слов. Раздели документ и отправь частями.");
        return res.status(200).json({ ok: true });
      }

      await tgSendMessage(chatId, "Обрабатываю текст через редактор…");

      // 4) правка AI
      const { refined } = await refineTextWithAI(original);

      // 5) PDF отчёт
      const report = await buildPdfReport({ original, refined });

      // 6) отправка
      await tgSendDocument(chatId, report, "proofreader_report.pdf");
      return res.status(200).json({ ok: true });
    }

    // === Обычный текст/команда /refine ===
    const isRefine = /^\/refine\b/i.test(String(text || ""));
    const plain = isRefine ? String(text).replace(/^\/refine\s*/i, "") : text;

    if (typeof plain === "string" && plain.trim()) {
      if (countWords(plain) > 1100) {
        await tgSendMessage(chatId, "⚠️ Текст >1100 слов. Раздели на части и пришли отдельно.");
        return res.status(200).json({ ok: true });
      }

      await tgSendMessage(chatId, "Принято. Обрабатываю текст…");
      const { refined } = await refineTextWithAI(plain);
      await tgSendMessage(chatId, refined || plain);
      return res.status(200).json({ ok: true });
    }

    // игнор всего остального
    return res.status(200).json({ ok: true });
  } catch (e) {
    await sleep(50);
    try {
      const update = req.body || {};
      const chatId = update?.message?.chat?.id || update?.edited_message?.chat?.id;
      if (chatId) await tgSendMessage(chatId, `Ошибка: ${String(e?.message || e)}`);
    } catch {}
    return res.status(200).json({ ok: false, error: String(e?.message || e) });
  }
}


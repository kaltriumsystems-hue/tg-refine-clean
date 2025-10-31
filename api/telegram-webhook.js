// Serverless handler for Telegram webhook (Vercel /api/telegram-webhook.js)
// Env: TELEGRAM_BOT_TOKEN, OPENAI_API_KEY
import OpenAI from "openai";

// --- Telegram API helpers ---
const TG_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TG_API = `https://api.telegram.org/bot${TG_TOKEN}`;

async function tgSendMessage(chatId, text) {
  await fetch(`${TG_API}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text }),
  });
}

async function tgSendDocument(chatId, buf, filename = "proofreader_report.pdf") {
  const form = new FormData();
  form.append("chat_id", String(chatId));
  form.append("document", new Blob([buf], { type: "application/pdf" }), filename);
  await fetch(`${TG_API}/sendDocument`, { method: "POST", body: form });
}

async function tgDownloadFile(fileId) {
  const meta = await fetch(`${TG_API}/getFile`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ file_id: fileId }),
  }).then(r => r.json());

  const path = meta?.result?.file_path;
  if (!path) throw new Error("File path missing from Telegram getFile");

  const url = `https://api.telegram.org/file/bot${TG_TOKEN}/${path}`;
  const ab = await fetch(url).then(r => r.arrayBuffer());
  return new Uint8Array(ab); // Uint8Array — нужно для pdf-parse
}

// --- PDF builder (pdfkit) ---
async function buildPdfReport({ originalText, refinedText, score, changeLog = [], toneNotes = [] }) {
  const { default: PDFDocument } = await import("pdfkit");
  const chunks = [];
  const doc = new PDFDocument({ size: "A4", margin: 36 });
  doc.on("data", c => chunks.push(c));
  doc.on("error", () => {});
  doc.on("end", () => {});

  doc.fontSize(18).text("Kaltrium Editorial Studio — Proofreading Report", { align: "center", underline: true });
  doc.moveDown(0.5);
  doc.fontSize(10).text(`Brand fit score: ${typeof score === "number" ? score : "—"}/100`);
  doc.moveDown(0.8);

  doc.fontSize(12).text("Refined Text:", { underline: true });
  doc.moveDown(0.2);
  doc.fontSize(11).text(refinedText || originalText || "(empty)");
  doc.moveDown(0.8);

  if (changeLog?.length) {
    doc.fontSize(12).text("Micro Changelog:", { underline: true });
    doc.moveDown(0.2);
    changeLog.forEach(i => doc.fontSize(11).text(`• ${i}`));
    doc.moveDown(0.6);
  }

  if (toneNotes?.length) {
    doc.fontSize(12).text("Tone & Style Notes:", { underline: true });
    doc.moveDown(0.2);
    toneNotes.forEach(i => doc.fontSize(11).text(`• ${i}`));
    doc.moveDown(0.6);
  }

  doc.fontSize(12).text("Original (first 200 chars):", { underline: true });
  doc.moveDown(0.2);
  doc.fontSize(10).text((originalText || "").slice(0, 200));

  doc.end();
  return await new Promise(resolve => {
    const buf = Buffer.concat(chunks);
    resolve(buf);
  });
}

// --- OpenAI refine (JSON ответ) ---
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

async function refineWithAI(text, language = "en", brandTone = "apple") {
  const system = [
    "You are a professional human proofreader & editor for BUSINESS & MARKETING texts.",
    "Tasks:",
    "1) Fix grammar, clarity, concision; keep meaning; preserve brand tone.",
    "2) Keep length roughly similar (±10%).",
    "3) Return JSON only with fields: refined_text (string), micro_changelog (string[]), tone_notes (string[]), brand_fit_score (number 0..100)."
  ].join("\n");

  const schema = {
    type: "object",
    properties: {
      refined_text: { type: "string" },
      micro_changelog: { type: "array", items: { type: "string" } },
      tone_notes: { type: "array", items: { type: "string" } },
      brand_fit_score: { type: "number" }
    },
    required: ["refined_text"]
  };

  const res = await openai.responses.create({
    model: "gpt-4.1-mini",
    input: [
      { role: "system", content: system },
      { role: "user", content: JSON.stringify({ text, language, brandTone }) }
    ],
    response_format: { type: "json_schema", json_schema: { name: "refine", schema, strict: true } }
  });

  const json = JSON.parse(res.output_text || "{}");
  return {
    refined_text: json.refined_text || "",
    micro_changelog: json.micro_changelog || [],
    tone_notes: json.tone_notes || [],
    brand_fit_score: Number.isFinite(json.brand_fit_score) ? json.brand_fit_score : 90
  };
}

// --- PDF extract (pdf-parse) ---
async function extractPdfText(uint8) {
  const { default: pdfParse } = await import("pdf-parse");
  const data = await pdfParse(Buffer.from(uint8));
  const text = String(data?.text || "")
    .replace(/\u0000/g, "")
    .replace(/[ \t]+/g, " ")
    .trim();
  return text;
}

// --- body reader для Node handler (на всякий случай) ---
async function readBody(req) {
  if (req.body) return req.body; // Vercel часто уже парсит JSON
  return await new Promise((resolve, reject) => {
    let raw = "";
    req.on("data", c => (raw += c));
    req.on("end", () => {
      try { resolve(JSON.parse(raw || "{}")); } catch { resolve({}); }
    });
    req.on("error", reject);
  });
}

// === MAIN HANDLER ===
export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(200).json({ ok: true, hint: "POST your Telegram updates here" });
  }

  try {
    const update = await readBody(req);
    const chatId =
      update?.message?.chat?.id ??
      update?.edited_message?.chat?.id ??
      update?.callback_query?.message?.chat?.id;
    const text = update?.message?.text;
    const doc = update?.message?.document;

    if (!chatId) return res.status(200).json({ ok: true });

    // /refine <Brand> <text>
    if (typeof text === "string" && /^\/refine/i.test(text)) {
      const src = text.replace(/^\/refine(\s+\S+)?\s*/i, "").trim();
      if (!src) {
        await tgSendMessage(chatId, "Отправь текст после /refine (например, “/refine Apple Your text…”)");
        return res.status(200).json({ ok: true });
      }
      const brand = (text.match(/^\/refine\s+(\S+)/i)?.[1] || "apple").toLowerCase();
      await tgSendMessage(chatId, `Принято. Редактирую (${brand})…`);

      try {
        const out = await refineWithAI(src, detectLang(src), brand);
        const pdf = await buildPdfReport({
          originalText: src,
          refinedText: out.refined_text || src,
          score: out.brand_fit_score,
          changeLog: out.micro_changelog,
          toneNotes: out.tone_notes
        });
        await tgSendDocument(chatId, pdf, "proofreader_report.pdf");
      } catch (e) {
        await tgSendMessage(chatId, `Ошибка при редактировании: ${String(e.message || e)}`);
      }
      return res.status(200).json({ ok: true });
    }

    // PDF document
    if (doc && ((doc.mime_type || "").includes("pdf") || (doc.file_name || "").toLowerCase().endsWith(".pdf"))) {
      await tgSendMessage(chatId, "Файл получен, извлекаю текст…");
      try {
        const bin = await tgDownloadFile(doc.file_id);
        const original = await extractPdfText(bin);
        if (!original) {
          await tgSendMessage(chatId, "Не удалось извлечь текст из PDF (возможно скан/картинка).");
          return res.status(200).json({ ok: true });
        }
        if (countWords(original) > 1100) {
          await tgSendMessage(chatId, "⚠️ В PDF >1100 слов. Раздели документ и пришли частями.");
          return res.status(200).json({ ok: true });
        }

        await tgSendMessage(chatId, "Обрабатываю текст через редактор…");
        const out = await refineWithAI(original, detectLang(original), "apple");
        const pdf = await buildPdfReport({
          originalText: original,
          refinedText: out.refined_text || original,
          score: out.brand_fit_score,
          changeLog: out.micro_changelog,
          toneNotes: out.tone_notes
        });
        await tgSendDocument(chatId, pdf, "proofreader_report.pdf");
      } catch (e) {
        await tgSendMessage(chatId, `Ошибка при обработке PDF: ${String(e.message || e)}`);
      }
      return res.status(200).json({ ok: true });
    }

    // Просто текст без команды
    if (typeof text === "string" && text.trim()) {
      if (countWords(text) > 1100) {
        await tgSendMessage(chatId, "⚠️ Текст >1100 слов. Раздели на части.");
        return res.status(200).json({ ok: true });
      }
      await tgSendMessage(chatId, "Принято. Обрабатываю текст…");
      try {
        const out = await refineWithAI(text, detectLang(text), "apple");
        const pdf = await buildPdfReport({
          originalText: text,
          refinedText: out.refined_text || text,
          score: out.brand_fit_score,
          changeLog: out.micro_changelog,
          toneNotes: out.tone_notes
        });
        await tgSendDocument(chatId, pdf, "proofreader_report.pdf");
      } catch (e) {
        await tgSendMessage(chatId, `Ошибка: ${String(e.message || e)}`);
      }
      return res.status(200).json({ ok: true });
    }

    // Игнор прочего
    return res.status(200).json({ ok: true });
  } catch (e) {
    return res.status(200).json({ ok: false, error: String(e.message || e) });
  }
}

// --- utils ---
function countWords(s = "") { return (s.match(/\S+/g) || []).length; }
function detectLang(s = "") {
  if (/[а-яё]/i.test(s)) return "ru";
  if (/[äöüß]/i.test(s)) return "de";
  return "en";
}


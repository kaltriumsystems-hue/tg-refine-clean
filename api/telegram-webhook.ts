// /api/telegram-webhook.ts
import type { VercelRequest, VercelResponse } from "@vercel/node";
import OpenAI from "openai";

// --- env
const TG_TOKEN = process.env.TELEGRAM_BOT_TOKEN!;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY!;
const TG_API = `https://api.telegram.org/bot${TG_TOKEN}`;

const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

// --- helpers: telegram
async function tgSendMessage(chatId: number, text: string) {
  await fetch(`${TG_API}/sendMessage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text }),
  });
}

async function tgSendDocument(chatId: number, bytes: Uint8Array, filename: string) {
  const form = new FormData();
  form.append("chat_id", String(chatId));
  form.append("document", new Blob([bytes], { type: "application/pdf" }), filename);
  await fetch(`${TG_API}/sendDocument`, { method: "POST", body: form as any });
}

async function tgDownloadFile(file_id: string): Promise<Uint8Array> {
  const meta = await fetch(`${TG_API}/getFile`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ file_id }),
  }).then(r => r.json());

  const path = meta?.result?.file_path;
  if (!path) throw new Error("No file_path from Telegram");

  const url = `https://api.telegram.org/file/bot${TG_TOKEN}/${path}`;
  const buf = await fetch(url).then(r => r.arrayBuffer());
  return new Uint8Array(buf);
}

// --- helpers: AI
const SYSTEM_PROMPT = `
You are Refine+, a senior marketing editor. Tighten, clarify, and polish business/marketing copy.
Return strict JSON with keys: refined_text (string), micro_changelog (array of strings), brand_fit_score (number 70-100), tone_notes (array), risks (array).
No extra prose outside JSON.
`.trim();

async function refine(text: string) {
  const completion = await openai.chat.completions.create({
    model: "gpt-4.1-mini",
    temperature: 0.2,
    response_format: { type: "json_object" },
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: text.trim() },
    ],
  });

  const raw = completion.choices[0]?.message?.content ?? "{}";
  let json: any = {};
  try { json = JSON.parse(raw); } catch {}
  return {
    refined_text: String(json.refined_text || text).trim(),
    micro_changelog: Array.isArray(json.micro_changelog) ? json.micro_changelog : [],
    brand_fit_score: Number.isFinite(json.brand_fit_score) ? Math.max(70, Math.min(100, Number(json.brand_fit_score))) : 90,
    tone_notes: Array.isArray(json.tone_notes) ? json.tone_notes : [],
    risks: Array.isArray(json.risks) ? json.risks : [],
  };
}

// --- PDF report (pdfkit)
async function buildPdfReport(args: {
  original: string;
  refined: string;
  score: number;
  changelog: string[];
  notes: string[];
  risks: string[];
}) {
  const PDFDocument = (await import("pdfkit")).default;
  const doc = new PDFDocument({ autoFirstPage: true, margin: 48 });
  const chunks: Uint8Array[] = [];
  const stream = doc as any;

  stream.on("data", (c: Uint8Array) => chunks.push(c));
  const end = new Promise<Uint8Array>(resolve => stream.on("end", () => resolve(Buffer.concat(chunks))));

  doc.fontSize(16).text("Proofreading & Editing Report", { align: "center", underline: true }).moveDown(0.5);
  doc.fontSize(10).text(`Date: ${new Date().toISOString().slice(0,10)}`, { align: "center" }).moveDown(1);

  doc.fontSize(12).text("Quality Overview", { underline: true }).moveDown(0.5);
  doc.fontSize(10).text(`Brand fit score: ${args.score}/100`).moveDown(0.6);

  if (args.changelog.length) {
    doc.fontSize(12).text("Editorial Summary", { underline: true }).moveDown(0.4);
    doc.fontSize(10);
    args.changelog.forEach(b => doc.text(`• ${b}`));
    doc.moveDown(0.8);
  }

  if (args.notes.length) {
    doc.fontSize(12).text("Tone & Style Notes", { underline: true }).moveDown(0.4);
    doc.fontSize(10);
    args.notes.forEach(n => doc.text(`• ${n}`));
    doc.moveDown(0.8);
  }

  if (args.risks.length) {
    doc.fontSize(12).text("Risks / Caveats", { underline: true }).moveDown(0.4);
    doc.fontSize(10);
    args.risks.forEach(r => doc.text(`• ${r}`));
    doc.moveDown(0.8);
  }

  doc.addPage();
  doc.fontSize(12).text("Before / After", { underline: true }).moveDown(0.6);
  doc.fontSize(11).text("Before:", { underline: true }).moveDown(0.2);
  doc.fontSize(10).text(args.original || "—").moveDown(0.8);
  doc.fontSize(11).text("After:", { underline: true }).moveDown(0.2);
  doc.fontSize(10).text(args.refined || "—").moveDown(1.2);

  doc.fontSize(9).text("Reviewed and refined for clarity, tone, and professional consistency.", { align: "center" });

  doc.end();
  return end;
}

// --- PDF text extraction (no pdfjs-dist)
async function extractTextFromPdf(fileBytes: Uint8Array): Promise<string> {
  const pdfParseModule: any = await import("pdf-parse");
  const pdfParse = pdfParseModule.default || pdfParseModule;
  const res = await pdfParse(Buffer.from(fileBytes));
  const text = String(res?.text || "")
    .replace(/\u0000/g, "")
    .replace(/[ \t]+/g, " ")
    .trim();
  return text;
}

// --- main handler
export default async function handler(req: VercelRequest, res: VercelResponse) {
  try {
    const update = req.body || {};
    const msg = update.message || update.edited_message || {};
    const chatId: number | undefined = msg.chat?.id;

    if (!chatId) return res.status(200).json({ ok: true });

    // TEXT
    if (typeof msg.text === "string" && msg.text.trim()) {
      const src = msg.text.trim();
      await tgSendMessage(chatId, "Принято. Обрабатываю текст…");

      const out = await refine(src);
      const pdf = await buildPdfReport({
        original: src,
        refined: out.refined_text,
        score: out.brand_fit_score,
        changelog: out.micro_changelog,
        notes: out.tone_notes,
        risks: out.risks,
      });
      await tgSendDocument(chatId, pdf, "proofreader_report.pdf");
      return res.status(200).json({ ok: true });
    }

    // DOCUMENT (PDF)
    const doc = msg.document;
    if (doc && ((doc.mime_type || "").includes("pdf") || (doc.file_name || "").toLowerCase().endsWith(".pdf"))) {
      await tgSendMessage(chatId, "Файл получен, извлекаю текст…");
      const bytes = await tgDownloadFile(doc.file_id);
      const original = await extractTextFromPdf(bytes);

      if (!original) {
        await tgSendMessage(chatId, "Не удалось извлечь текст из PDF (скан/изображение не поддерживается).");
        return res.status(200).json({ ok: true });
      }

      await tgSendMessage(chatId, "Обрабатываю текст через редактор…");
      const out = await refine(original);

      const pdf = await buildPdfReport({
        original,
        refined: out.refined_text,
        score: out.brand_fit_score,
        changelog: out.micro_changelog,
        notes: out.tone_notes,
        risks: out.risks,
      });
      await tgSendDocument(chatId, pdf, "proofreader_report.pdf");
      return res.status(200).json({ ok: true });
    }

    // ignore other updates (photos, stickers, etc.)
    return res.status(200).json({ ok: true });
  } catch (e: any) {
    console.error(e);
    return res.status(200).json({ ok: false, error: String(e?.message || e) });
  }
}

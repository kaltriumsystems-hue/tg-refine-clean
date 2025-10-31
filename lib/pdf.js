// /lib/pdf.js
export async function extractTextFromPDF(buffer) {
  const pdfParse = (await import("pdf-parse")).default;
  const { text } = await pdfParse(buffer);
  return String(text || "")
    .replace(/\u0000/g, "")
    .replace(/[ \t]+/g, " ")
    .trim();
}

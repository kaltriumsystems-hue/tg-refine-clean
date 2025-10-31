// /lib/openai.js
import OpenAI from "openai";
const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

export async function refineText(text) {
  const sys =
    "You are a professional editor. Fix grammar, clarity, flow, and tone. Preserve meaning and length as much as possible. Reply with the improved text only.";
  const r = await client.chat.completions.create({
    model: "gpt-4o-mini",
    temperature: 0.2,
    messages: [
      { role: "system", content: sys },
      { role: "user", content: text }
    ]
  });
  return r.choices?.[0]?.message?.content?.trim() || "";
}

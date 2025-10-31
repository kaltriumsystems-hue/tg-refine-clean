export default function handler(req, res) {
  const hasOpenAI = !!process.env.OPENAI_API_KEY && process.env.OPENAI_API_KEY.trim().length > 10;
  const hasTg = !!process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_BOT_TOKEN.trim().length > 10;
  res.status(200).json({
    ok: true,
    OPENAI_API_KEY_present: hasOpenAI,
    TELEGRAM_BOT_TOKEN_present: hasTg
  });
}

export default function handler(req, res) {
  res.status(200).json({
    ok: true,
    has_OPENAI: Boolean(process.env.OPENAI_API_KEY),
    has_TG: Boolean(process.env.TELEGRAM_BOT_TOKEN)
  });
}

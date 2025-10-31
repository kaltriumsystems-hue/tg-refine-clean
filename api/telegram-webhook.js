// /api/telegram-webhook.js
export default async function handler(req, res) {
  try {
    const update = req.body || {};
    const chatId = update.message?.chat?.id;
    const text = update.message?.text || '(без текста)';

    if (chatId) {
      await fetch(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: chatId,
          text: `✅ Принято: «${text}»`
        })
      });
    }

    return res.status(200).json({ ok: true });
  } catch (e) {
    console.error(e);
    // Telegram требует ответ 200 даже при ошибках
    return res.status(200).json({ ok: false, error: String(e) });
  }
}



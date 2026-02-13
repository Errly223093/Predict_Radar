import { config } from "../config.js";

type TelegramMode = "bot" | "user";

function pickMode(): TelegramMode | null {
  const explicit = config.TELEGRAM_MODE;
  if (explicit === "bot" || explicit === "user") return explicit;

  if (config.TELEGRAM_BOT_TOKEN && config.TELEGRAM_CHAT_ID) return "bot";
  if (config.TELEGRAM_API_ID && config.TELEGRAM_API_HASH && config.TELEGRAM_SESSION) return "user";
  return null;
}

async function sendBot(text: string): Promise<void> {
  if (!config.TELEGRAM_BOT_TOKEN || !config.TELEGRAM_CHAT_ID) return;

  const response = await fetch(
    `https://api.telegram.org/bot${config.TELEGRAM_BOT_TOKEN}/sendMessage`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: config.TELEGRAM_CHAT_ID,
        text,
        disable_web_page_preview: true
      })
    }
  );

  if (response.status === 429) {
    const body = (await response.json().catch(() => null)) as
      | { parameters?: { retry_after?: number } }
      | null;
    const retrySeconds = body?.parameters?.retry_after ?? 1;
    await new Promise((resolve) => setTimeout(resolve, retrySeconds * 1000));
    return sendBot(text);
  }

  if (!response.ok) {
    const payload = await response.text();
    throw new Error(`Telegram bot send failed ${response.status}: ${payload}`);
  }
}

let userClientPromise: Promise<unknown> | null = null;

async function getUserClient(): Promise<any | null> {
  if (!config.TELEGRAM_API_ID || !config.TELEGRAM_API_HASH || !config.TELEGRAM_SESSION) return null;
  if (userClientPromise) return userClientPromise;

  userClientPromise = (async () => {
    const { TelegramClient } = await import("telegram");
    const { StringSession } = await import("telegram/sessions");

    const client = new TelegramClient(new StringSession(config.TELEGRAM_SESSION), config.TELEGRAM_API_ID, config.TELEGRAM_API_HASH, {
      connectionRetries: 1
    });

    await client.connect();
    return client;
  })();

  return userClientPromise as any;
}

async function sendUser(text: string): Promise<void> {
  const client = await getUserClient();
  if (!client) return;

  const target = (config.TELEGRAM_TARGET ?? "me").trim() || "me";
  await client.sendMessage(target, { message: text, linkPreview: false });
}

export async function sendTelegramMessage(text: string): Promise<void> {
  if (!config.TELEGRAM_ENABLED) return;

  const mode = pickMode();
  if (!mode) return;

  if (mode === "bot") {
    await sendBot(text);
    return;
  }

  await sendUser(text);
}

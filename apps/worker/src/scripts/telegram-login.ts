import "dotenv/config";
import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";

async function main(): Promise<void> {
  const apiIdRaw = process.env.TELEGRAM_API_ID;
  const apiHash = process.env.TELEGRAM_API_HASH;

  const apiId = apiIdRaw ? Number(apiIdRaw) : Number.NaN;
  if (!Number.isFinite(apiId) || apiId <= 0) {
    throw new Error("Missing TELEGRAM_API_ID (set it in .env first).");
  }
  if (!apiHash || apiHash.trim().length < 10) {
    throw new Error("Missing TELEGRAM_API_HASH (set it in .env first).");
  }

  const { TelegramClient } = await import("telegram");
  const { StringSession } = await import("telegram/sessions/index.js");

  const rl = readline.createInterface({ input, output });
  const ask = async (prompt: string): Promise<string> => {
    const answer = await rl.question(prompt);
    return answer.trim();
  };

  const session = new StringSession("");
  const client = new TelegramClient(session, apiId, apiHash, { connectionRetries: 1 });

  await client.start({
    phoneNumber: async () => process.env.TELEGRAM_PHONE?.trim() || (await ask("Phone number (+1...): ")),
    password: async () => process.env.TELEGRAM_PASSWORD?.trim() || (await ask("2FA password (if enabled): ")),
    phoneCode: async () => await ask("Login code: "),
    onError: (err) => console.error("[telegram-login] error", err)
  });

  rl.close();

  const saved = client.session.save();
  console.log("");
  console.log("Login OK. Add this to your .env:");
  console.log(`TELEGRAM_SESSION=${saved}`);

  await client.disconnect();
}

main().catch((error) => {
  console.error("[telegram-login] failed", error);
  process.exitCode = 1;
});

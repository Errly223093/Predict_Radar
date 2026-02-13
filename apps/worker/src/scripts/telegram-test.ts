import { sendTelegramMessage } from "../integrations/telegram.js";

async function main(): Promise<void> {
  const text = `Predict Radar test message (${new Date().toISOString()})`;
  await sendTelegramMessage(text);
  console.log("telegram:test complete");
}

main().catch((error) => {
  console.error("[telegram:test] failed", error);
  process.exitCode = 1;
});


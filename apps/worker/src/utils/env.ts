import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";

export function loadEnvUpwards(moduleUrl: string): void {
  const startDir = path.dirname(fileURLToPath(moduleUrl));
  let dir = startDir;

  for (let i = 0; i < 8; i += 1) {
    const envPath = path.join(dir, ".env");
    if (existsSync(envPath)) {
      dotenv.config({ path: envPath });
      return;
    }

    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }

  // Fallback: use default dotenv lookup (cwd).
  dotenv.config();
}


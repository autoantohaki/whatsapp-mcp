import { mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** Repository root (the folder that holds package.json and CLAUDE.md). */
export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** Everything private to this computer: WhatsApp login, message archive, logs. */
export const DATA_DIR = resolve(process.env.WHATSAPP_MCP_DATA ?? join(ROOT, "data"));

export const paths = {
  database: join(DATA_DIR, "messages.db"),
  auth: join(DATA_DIR, "whatsapp-login"),
  serviceInfo: join(DATA_DIR, "service.json"),
  serviceLock: join(DATA_DIR, "service.lock"),
  serviceLog: join(DATA_DIR, "service.log"),
  qrImage: join(DATA_DIR, "whatsapp-qr.png"),
  serviceScript: join(ROOT, "src", "service.ts"),
};

export function ensureDataDir(): void {
  mkdirSync(DATA_DIR, { recursive: true });
}

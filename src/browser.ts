import { existsSync } from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { systemBrowserCandidates } = require("./browser-paths.cjs") as {
  systemBrowserCandidates(): string[];
};

/**
 * The browser WhatsApp Web runs in. An installed Edge or Chrome is preferred;
 * undefined lets puppeteer use the Chrome it downloaded during npm install.
 */
export function findSystemBrowser(): string | undefined {
  const configured = process.env.CHROMIUM_EXECUTABLE_PATH;
  if (configured && existsSync(configured)) return configured;
  return systemBrowserCandidates().find((path) => existsSync(path));
}

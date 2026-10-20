// Runs at the start of every Claude session (see .claude/settings.json) and
// tells Claude whether first-time setup is still needed. Plain JavaScript with
// no dependencies so it works before `npm install`.
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const [major, minor] = process.versions.node.split(".").map(Number);
const problems = [];

if (major < 22 || (major === 22 && minor < 18)) {
  problems.push(`Node.js ${process.versions.node} is too old (need 22.18 or newer, LTS recommended).`);
}
if (!existsSync(join(root, "node_modules", "whatsapp-web.js"))) {
  problems.push("Dependencies are not installed yet (npm install has not run).");
}

if (problems.length) {
  console.log(`WHATSAPP SETUP NEEDED: ${problems.join(" ")} Follow "First-time setup" in CLAUDE.md before anything else.`);
} else {
  const linked = existsSync(join(root, "data", "whatsapp-login"));
  let service = "not running";
  try {
    const info = JSON.parse(readFileSync(join(root, "data", "service.json"), "utf8"));
    process.kill(info.pid, 0);
    service = "running";
  } catch {
    // not running; the first WhatsApp tool call starts it
  }
  console.log(
    `WhatsApp setup OK. Login saved on this computer: ${linked ? "yes" : "no (needs QR pairing)"}. Background service: ${service}.`,
  );
}

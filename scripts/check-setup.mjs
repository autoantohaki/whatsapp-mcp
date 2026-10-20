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
const needed = ["whatsapp-web.js", "@modelcontextprotocol/sdk", "@anthropic-ai/claude-agent-sdk"];
if (needed.some((name) => !existsSync(join(root, "node_modules", name)))) {
  problems.push("Dependencies are missing or outdated (run npm install).");
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

// Claude Code passes the session details on stdin. The id lets whatsapp_alerts
// link this conversation to a client for background drafts.
try {
  const input = process.stdin.isTTY ? {} : JSON.parse(readFileSync(0, "utf8") || "{}");
  if (input.session_id) console.log(`This conversation's session id: ${input.session_id}`);
} catch {
  // not started by Claude Code
}
if (process.env.WHATSAPP_LIVE === "1") {
  console.log("Live WhatsApp messages are ON in this conversation (started with the live launcher).");
}

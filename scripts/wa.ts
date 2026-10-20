// Command-line access to the WhatsApp service, for when the `whatsapp` MCP
// tools are not loaded in the current Claude session (e.g. right after the
// first install). Usage:
//   node scripts/wa.ts status            open the QR page if WhatsApp needs linking
//   node scripts/wa.ts inbox
//   node scripts/wa.ts read '{"chat":"Maria Silva","limit":30}'
//   node scripts/wa.ts <method> '<json params>'   (methods: findChat, search, send, sendFile, downloadMedia, restart)
import { callService, openInBrowser, pairingUrl } from "../src/service-client.ts";
import type { PairingState } from "../src/whatsapp-service.ts";

const [method = "status", json = "{}"] = process.argv.slice(2);
try {
  const result = await callService(method, JSON.parse(json));
  if (method === "status" && (result as PairingState).state === "awaiting_qr") {
    const url = await pairingUrl();
    openInBrowser(url);
    console.log(`QR pairing page opened: ${url}`);
  }
  console.log(JSON.stringify(result, null, 2));
} catch (cause) {
  console.error(cause instanceof Error ? cause.message : String(cause));
  process.exitCode = 1;
}

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { NormalizedMessage } from "../src/domain.ts";

const dataDir = mkdtempSync(join(tmpdir(), "whatsapp-mcp-"));
const env = { ...process.env, WHATSAPP_MCP_DATA: dataDir, WHATSAPP_MCP_FAKE: "1" } as Record<string, string>;

function connectClient(): { client: Client; transport: StdioClientTransport } {
  const transport = new StdioClientTransport({ command: process.execPath, args: ["src/mcp.ts"], env, stderr: "ignore" });
  return { client: new Client({ name: "test", version: "1.0.0" }), transport };
}

async function call(client: Client, name: string, args: Record<string, unknown> = {}): Promise<string> {
  const result = (await client.callTool({ name, arguments: args })) as { content: Array<{ type: string; text?: string }>; isError?: boolean };
  const output = result.content.filter((item) => item.type === "text").map((item) => item.text).join("\n");
  if (result.isError) throw new Error(output);
  return output;
}

async function inject(
  message: Partial<NormalizedMessage> & { providerMessageId: string; text: string },
  media?: object,
  lid?: { lid: string; phoneId: string },
) {
  const info = JSON.parse(readFileSync(join(dataDir, "service.json"), "utf8"));
  const full: NormalizedMessage = {
    provider: "fake",
    chatExternalId: "5511999990001@c.us",
    senderExternalId: "5511999990001@c.us",
    direction: "inbound",
    origin: "customer",
    kind: "text",
    occurredAt: new Date().toISOString(),
    ...message,
  };
  const response = await fetch(`http://127.0.0.1:${info.port}/rpc`, {
    method: "POST",
    headers: { authorization: `Bearer ${info.token}`, "content-type": "application/json" },
    body: JSON.stringify({ method: "fakeInject", params: { message: full, media, lid } }),
  });
  expect(await response.json()).toEqual({ result: { ok: true } });
}

let first: ReturnType<typeof connectClient>;
let second: ReturnType<typeof connectClient>;

beforeAll(async () => {
  first = connectClient();
  second = connectClient();
  await first.client.connect(first.transport);
  await second.client.connect(second.transport);
}, 30_000);

afterAll(async () => {
  await first.client.close();
  await second.client.close();
  if (existsSync(join(dataDir, "service.json"))) {
    const { pid } = JSON.parse(readFileSync(join(dataDir, "service.json"), "utf8"));
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      // already gone
    }
  }
  await new Promise((resolve) => setTimeout(resolve, 500));
  rmSync(dataDir, { recursive: true, force: true });
});

describe("WhatsApp MCP end to end (fake WhatsApp)", () => {
  it("lists the tools", async () => {
    const { tools } = await first.client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      "whatsapp_download_media",
      "whatsapp_find_chat",
      "whatsapp_inbox",
      "whatsapp_read",
      "whatsapp_search",
      "whatsapp_send",
      "whatsapp_send_file",
      "whatsapp_status",
    ]);
  });

  it("starts one shared background service for every session", async () => {
    const [a, b] = await Promise.all([call(first.client, "whatsapp_status"), call(second.client, "whatsapp_status")]);
    expect(a).toContain("connected");
    expect(b).toContain("connected");
    const info = JSON.parse(readFileSync(join(dataDir, "service.json"), "utf8"));
    expect(Number(readFileSync(join(dataDir, "service.lock"), "utf8"))).toBe(info.pid);
  }, 60_000);

  it("keeps incoming messages, shows them in the inbox, and clears them once read", async () => {
    await inject({ providerMessageId: "in-1", text: "Bom dia, doutor. Recebi a notificação de despejo." });
    await inject({ providerMessageId: "in-2", text: "Posso mandar o contrato?" });
    const inbox = await call(first.client, "whatsapp_inbox");
    expect(inbox).toContain("5511999990001@c.us");
    expect(inbox).toContain("2 new");

    const read = await call(second.client, "whatsapp_read", { chat: "+55 11 99999-0001" });
    expect(read).toContain("notificação de despejo");
    expect(read.indexOf("in-1")).toBeLessThan(read.indexOf("in-2"));
    expect(await call(first.client, "whatsapp_inbox")).toBe("No new messages.");
  });

  it("searches ignoring accents and case", async () => {
    const found = await call(first.client, "whatsapp_search", { query: "NOTIFICACAO despejo" });
    expect(found).toContain("in-1");
    expect(found).not.toContain("in-2");
  });

  it("sends text and files, and records them", async () => {
    const sent = await call(first.client, "whatsapp_send", { chat: "5511999990001@c.us", text: "Pode sim, por favor." });
    expect(sent).toContain("Sent to 5511999990001@c.us");
    const retry = await call(first.client, "whatsapp_send", { chat: "5511999990001@c.us", text: "Pode sim, por favor." });
    expect(retry).toBe(sent);

    const file = join(dataDir, "procuracao.pdf");
    writeFileSync(file, "%PDF-1.4 test");
    expect(await call(first.client, "whatsapp_send_file", { chat: "5511999990001@c.us", path: file, caption: "Procuração" })).toContain(
      "procuracao.pdf",
    );

    const read = await call(first.client, "whatsapp_read", { chat: "5511999990001@c.us" });
    expect(read).toContain("You (sent via Claude): Pode sim, por favor.");
    expect(read).toContain("[document: procuracao.pdf");
  });

  it("downloads an attachment into a client folder", async () => {
    await inject(
      { providerMessageId: "in-doc", text: "", kind: "document", media: { hasMedia: true, mimeType: "application/pdf", filename: "contrato.pdf" } },
      { mimeType: "application/pdf", base64: Buffer.from("%PDF contract").toString("base64"), filename: "contrato.pdf" },
    );
    const folder = join(dataDir, "clients", "Maria Silva", "documents");
    const saved = await call(first.client, "whatsapp_download_media", { message_id: "in-doc", folder });
    const path = saved.match(/Saved to (.*) \(/)![1]!;
    expect(path).toContain("contrato.pdf");
    expect(readFileSync(path, "utf8")).toBe("%PDF contract");
    expect(await call(first.client, "whatsapp_read", { chat: "5511999990001@c.us" })).toContain(`saved at ${path}`);
  });

  it("files messages from a private @lid ID under the client's phone number", async () => {
    await inject(
      { providerMessageId: "in-lid", text: "Mensagem pelo novo ID", chatExternalId: "99887766@lid", senderExternalId: "99887766@lid" },
      undefined,
      { lid: "99887766@lid", phoneId: "5511999990001@c.us" },
    );
    const read = await call(first.client, "whatsapp_read", { chat: "5511999990001@c.us" });
    expect(read).toContain("Mensagem pelo novo ID");
    expect(read).toContain("procuracao.pdf");
    expect(await call(first.client, "whatsapp_read", { chat: "99887766@lid" })).toContain("Mensagem pelo novo ID");
  });

  it("explains unknown chats instead of guessing", async () => {
    await expect(call(first.client, "whatsapp_read", { chat: "Nobody Like This" })).rejects.toThrow(/No WhatsApp chat matches/);
  });

  it("keeps the service alive after a Claude session closes", async () => {
    await first.client.close();
    first = connectClient();
    await first.client.connect(first.transport);
    expect(await call(first.client, "whatsapp_search", { query: "contrato" })).toContain("in-2");
  });
});

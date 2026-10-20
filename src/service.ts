// The background WhatsApp service. One runs per computer; Claude sessions
// start it on demand (see service-client.ts) and talk to it over localhost.
import { randomBytes } from "node:crypto";
import { appendFileSync, closeSync, existsSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { findSystemBrowser } from "./browser.ts";
import type { MessagingChannel } from "./domain.ts";
import { DATA_DIR, ROOT, ensureDataDir, paths } from "./paths.ts";
import { MessageStore } from "./store.ts";
import { FakeMessagingChannel } from "./whatsapp/fake-channel.ts";
import { WhatsAppWebChannel } from "./whatsapp/web-channel.ts";
import { WhatsAppService } from "./whatsapp-service.ts";
import { pairingPage } from "./pairing-page.ts";
import QRCode from "qrcode";

export interface ServiceInfo {
  readonly port: number;
  readonly token: string;
  readonly pid: number;
  readonly startedAt: string;
}

function log(line: string): void {
  const entry = `${new Date().toISOString()} ${line}\n`;
  try {
    appendFileSync(paths.serviceLog, entry);
  } catch {
    process.stderr.write(entry);
  }
}

function isRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (cause) {
    return (cause as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Only one service may own the WhatsApp login. Returns false if another one does. */
function acquireLock(): boolean {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const fd = openSync(paths.serviceLock, "wx");
      writeFileSync(fd, String(process.pid));
      closeSync(fd);
      return true;
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code !== "EEXIST") throw cause;
      const owner = Number(readFileSync(paths.serviceLock, "utf8"));
      if (owner && owner !== process.pid && isRunning(owner)) return false;
      rmSync(paths.serviceLock, { force: true });
    }
  }
  return false;
}

function createChannel(): MessagingChannel {
  if (process.env.WHATSAPP_MCP_FAKE === "1") return new FakeMessagingChannel();
  const executablePath = findSystemBrowser();
  log(executablePath ? `Using browser ${executablePath}` : "Using the browser bundled with puppeteer");
  return new WhatsAppWebChannel({
    authDataPath: paths.auth,
    clientId: "main",
    headless: true,
    ...(executablePath ? { executablePath } : {}),
    browserArgs: [
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-extensions",
      // Chromium refuses to start as root (servers, containers) without this.
      ...(process.getuid?.() === 0 ? ["--no-sandbox"] : []),
    ],
  });
}

type Handler = (service: WhatsAppService, params: Record<string, any>, channel: MessagingChannel) => unknown;

const methods: Record<string, Handler> = {
  status: (service) => service.pairing(),
  restart: (service) => service.restart(),
  inbox: (service) => service.inbox(),
  findChat: (service, params) => service.findChats(String(params.query ?? ""), params.limit),
  read: (service, params) => service.read(params as any),
  search: (service, params) => service.search(params as any),
  send: (service, params) => service.send(params as any),
  sendFile: (service, params) => service.sendFile(params as any),
  downloadMedia: (service, params) => service.downloadMedia(params as any),
  // Test hooks, only meaningful with WHATSAPP_MCP_FAKE=1.
  fakeInject: async (_service, params, channel) => {
    if (!(channel instanceof FakeMessagingChannel)) throw new Error("Not a test service");
    if (params.media) channel.seedMedia(params.message.providerMessageId, params.media);
    await channel.injectMessage(params.message);
    return { ok: true };
  },
};

async function readBody(request: IncomingMessage): Promise<any> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
}

function reply(response: ServerResponse, status: number, body: unknown, type = "application/json"): void {
  response.writeHead(status, { "content-type": `${type}; charset=utf-8`, "cache-control": "no-store" });
  response.end(type === "application/json" ? JSON.stringify(body) : String(body));
}

async function main(): Promise<void> {
  ensureDataDir();
  if (!acquireLock()) {
    log("Another WhatsApp service is already running; exiting.");
    return;
  }

  const token = randomBytes(24).toString("hex");
  const store = new MessageStore(paths.database);
  const channel = createChannel();
  const service = new WhatsAppService({ channel, store, qrImagePath: paths.qrImage, workspaceRoot: ROOT, log });

  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    const authorized =
      request.headers.authorization === `Bearer ${token}` || url.searchParams.get("token") === token;
    if (!authorized) return reply(response, 403, { error: "forbidden" });
    try {
      if (request.method === "GET" && url.pathname === "/health") return reply(response, 200, { ok: true, pid: process.pid });
      if (request.method === "GET" && url.pathname === "/pair") return reply(response, 200, pairingPage(token), "text/html");
      if (request.method === "GET" && url.pathname === "/pair/state") return reply(response, 200, service.pairing());
      if (request.method === "GET" && url.pathname === "/pair/qr.svg") {
        const qr = service.pairing().qr;
        if (!qr) return reply(response, 404, { error: "no QR code right now" });
        return reply(response, 200, await QRCode.toString(qr, { type: "svg", margin: 2 }), "image/svg+xml");
      }
      if (request.method === "POST" && url.pathname === "/rpc") {
        const { method, params } = await readBody(request);
        const handler = methods[method];
        if (!handler) return reply(response, 404, { error: `Unknown method ${method}` });
        return reply(response, 200, { result: await handler(service, params ?? {}, channel) });
      }
      reply(response, 404, { error: "not found" });
    } catch (cause) {
      reply(response, 200, { error: cause instanceof Error ? cause.message : String(cause) });
    }
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const info: ServiceInfo = {
    port: (server.address() as AddressInfo).port,
    token,
    pid: process.pid,
    startedAt: new Date().toISOString(),
  };
  writeFileSync(paths.serviceInfo, JSON.stringify(info, null, 2));
  log(`WhatsApp service listening on 127.0.0.1:${info.port} (data in ${DATA_DIR})`);

  const shutdown = async () => {
    log("Shutting down");
    server.close();
    await service.stop().catch(() => undefined);
    store.close();
    if (existsSync(paths.serviceInfo)) rmSync(paths.serviceInfo, { force: true });
    rmSync(paths.serviceLock, { force: true });
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  process.on("uncaughtException", (error) => log(`Unexpected error: ${error.stack ?? error.message}`));
  process.on("unhandledRejection", (error) => log(`Unexpected rejection: ${String(error)}`));

  await service.start();
}

main().catch((error) => {
  log(`Service failed to start: ${error instanceof Error ? error.stack : String(error)}`);
  rmSync(paths.serviceLock, { force: true });
  process.exit(1);
});

import { spawn } from "node:child_process";
import { existsSync, openSync, readFileSync } from "node:fs";
import { ROOT, ensureDataDir, paths } from "./paths.ts";
import type { ServiceInfo } from "./service.ts";

const START_TIMEOUT_MS = 30_000;
const CALL_TIMEOUT_MS = 180_000;

function readInfo(): ServiceInfo | undefined {
  if (!existsSync(paths.serviceInfo)) return undefined;
  try {
    return JSON.parse(readFileSync(paths.serviceInfo, "utf8")) as ServiceInfo;
  } catch {
    return undefined;
  }
}

async function healthy(info: ServiceInfo): Promise<boolean> {
  try {
    const response = await fetch(`http://127.0.0.1:${info.port}/health`, {
      headers: { authorization: `Bearer ${info.token}` },
      signal: AbortSignal.timeout(2000),
    });
    return response.ok;
  } catch {
    return false;
  }
}

function launchService(): void {
  ensureDataDir();
  const log = openSync(paths.serviceLog, "a");
  const child = spawn(process.execPath, [...process.execArgv, "--disable-warning=ExperimentalWarning", paths.serviceScript], {
    cwd: ROOT,
    detached: true,
    windowsHide: true,
    stdio: ["ignore", log, log],
    env: process.env,
  });
  child.unref();
}

let launching: Promise<ServiceInfo> | undefined;

/**
 * Returns the running WhatsApp service, starting it in the background if no
 * Claude session has started it yet. It keeps running after Claude closes so
 * incoming messages are still saved.
 */
export async function ensureService(): Promise<ServiceInfo> {
  const current = readInfo();
  if (current && (await healthy(current))) return current;
  launching ??= (async () => {
    launchService();
    const deadline = Date.now() + START_TIMEOUT_MS;
    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 500));
      const info = readInfo();
      if (info && (await healthy(info))) return info;
    }
    throw new Error(
      `The WhatsApp background service did not start. Its log is at ${paths.serviceLog}; read the end of it to see why.`,
    );
  })().finally(() => {
    launching = undefined;
  });
  return launching;
}

export async function callService<T = unknown>(method: string, params: Record<string, unknown> = {}): Promise<T> {
  const info = await ensureService();
  const response = await fetch(`http://127.0.0.1:${info.port}/rpc`, {
    method: "POST",
    headers: { authorization: `Bearer ${info.token}`, "content-type": "application/json" },
    body: JSON.stringify({ method, params }),
    signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
  });
  const body = (await response.json()) as { result?: T; error?: string };
  if (body.error) throw new Error(body.error);
  return body.result as T;
}

export async function pairingUrl(): Promise<string> {
  const info = await ensureService();
  return `http://127.0.0.1:${info.port}/pair?token=${info.token}`;
}

export function openInBrowser(url: string): void {
  const [command, args] =
    process.platform === "win32"
      ? ["rundll32", ["url.dll,FileProtocolHandler", url]]
      : process.platform === "darwin"
        ? ["open", [url]]
        : ["xdg-open", [url]];
  spawn(command, args, { detached: true, stdio: "ignore", windowsHide: true }).on("error", () => undefined).unref();
}

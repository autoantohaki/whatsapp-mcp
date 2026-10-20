import { existsSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, relative, resolve } from "node:path";
import { z } from "zod";
import type { AgentRun, AgentRunner } from "./autopilot.ts";

const BUSY_WINDOW_MS = 3 * 60 * 1000;
const READ_ONLY_TOOLS = new Set(["Read", "Glob", "Grep", "LS", "TodoWrite"]);
const EDIT_TOOLS = new Set(["Write", "Edit", "MultiEdit"]);

function claudeDir(): string {
  return process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude");
}

/** Path of a saved Claude Code conversation, wherever its project folder is. */
function sessionFile(sessionId: string): string | undefined {
  const projects = join(claudeDir(), "projects");
  if (!existsSync(projects)) return undefined;
  for (const project of readdirSync(projects)) {
    const file = join(projects, project, `${sessionId}.jsonl`);
    if (existsSync(file)) return file;
  }
  return undefined;
}

/** True when the lawyer used that conversation in the last few minutes. */
export function sessionInUse(sessionId: string): boolean {
  const file = sessionFile(sessionId);
  return Boolean(file && Date.now() - statSync(file).mtimeMs < BUSY_WINDOW_MS);
}

/**
 * Runs Claude Code in the background (Claude Agent SDK, using the same login
 * as the Claude app on this computer) inside the client's conversation.
 */
export function createClaudeRunner(workspaceRoot: string, log: (line: string) => void): AgentRunner {
  const clientsDir = resolve(workspaceRoot, "clients");
  return async (run: AgentRun) => {
    const sdk = await import("@anthropic-ai/claude-agent-sdk");
    const text = (value: string) => ({ content: [{ type: "text" as const, text: value }] });
    const tools = [
      sdk.tool(
        "read_chat",
        "Reads this client's WhatsApp chat, oldest to newest.",
        { limit: z.number().int().min(1).max(200).optional(), before: z.string().optional() },
        async (args) => text(await run.tools.readChat(args.limit, args.before)),
      ),
      sdk.tool("search_chat", "Keyword search in this client's WhatsApp history.", { query: z.string() }, async (args) =>
        text(await run.tools.search(args.query)),
      ),
      sdk.tool(
        "propose_reply",
        "Sends your proposed WhatsApp reply to the lawyer for approval (not to the client).",
        { text: z.string().min(1) },
        async (args) => text(await run.tools.proposeReply(args.text)),
      ),
      sdk.tool("no_reply_needed", "Use when the client's message needs no answer.", { reason: z.string() }, async (args) =>
        text(await run.tools.noReplyNeeded(args.reason)),
      ),
    ];
    const allowed = new Set(tools.map((tool) => `mcp__autopilot__${tool.name}`));

    const conversation = sdk.query({
      prompt: run.prompt,
      options: {
        cwd: workspaceRoot,
        ...(run.sessionId ? { resume: run.sessionId, forkSession: run.fork } : {}),
        settingSources: ["project"],
        systemPrompt: { type: "preset", preset: "claude_code" },
        mcpServers: { autopilot: sdk.createSdkMcpServer({ name: "autopilot", version: "1.0.0", tools }) },
        maxTurns: 30,
        permissionMode: "default",
        canUseTool: async (toolName, input) => {
          if (allowed.has(toolName) || READ_ONLY_TOOLS.has(toolName)) return { behavior: "allow", updatedInput: input };
          if (toolName.startsWith("mcp__whatsapp__") && !/send/.test(toolName)) return { behavior: "allow", updatedInput: input };
          if (EDIT_TOOLS.has(toolName)) {
            const target = resolve(workspaceRoot, String(input.file_path ?? ""));
            const inside = !relative(clientsDir, target).startsWith("..");
            if (inside) return { behavior: "allow", updatedInput: input };
          }
          return { behavior: "deny", message: `${toolName} is not available to the WhatsApp autopilot.` };
        },
      },
    });

    let sessionId: string | undefined;
    for await (const message of conversation) {
      if ("session_id" in message && typeof message.session_id === "string") sessionId = message.session_id;
      if (message.type === "result" && message.subtype !== "success") {
        log(`Autopilot run ended with ${message.subtype}`);
      }
    }
    return { ...(sessionId ? { sessionId } : {}) };
  };
}

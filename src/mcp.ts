// MCP server that Claude Code starts for each session (see .mcp.json). It is a
// thin layer over the shared background WhatsApp service.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { readFileSync } from "node:fs";
import { z } from "zod";
import type { StoredChat, StoredMessage } from "./store.ts";
import { randomUUID } from "node:crypto";
import { callService, ensureService, openInBrowser, pairingUrl } from "./service-client.ts";
import type { LiveEvent } from "./live-feed.ts";
import type { PairingState } from "./whatsapp-service.ts";

// Set by the "live" launcher, which starts Claude Code with this server as a channel.
const LIVE = process.env.WHATSAPP_LIVE === "1";

const server = new McpServer(
  { name: "whatsapp", version: "0.2.0" },
  {
    capabilities: { experimental: { "claude/channel": {} } },
    instructions: LIVE
      ? 'New client messages arrive live as <channel source="whatsapp"> events. When one arrives: if this conversation is about that client, ' +
        "catch up (notes.md, whatsapp_read) and draft a reply for the user to approve; never send without the user's OK. " +
        "If it is about another client, tell the user in one line who wrote and suggest opening that client's conversation."
      : undefined,
  },
);

/** Which chat this conversation follows live: one chat id, or every chat with alerts on. */
let watching = "alerts";

type Content = { type: "text"; text: string } | { type: "image"; data: string; mimeType: string };

function text(value: string): { content: Content[] } {
  return { content: [{ type: "text", text: value }] };
}

function failure(cause: unknown): { content: Content[]; isError: true } {
  return { content: [{ type: "text", text: cause instanceof Error ? cause.message : String(cause) }], isError: true };
}

function tool<Shape extends z.ZodRawShape>(
  name: string,
  config: { title: string; description: string; inputSchema: Shape; readOnly: boolean },
  run: (args: z.infer<z.ZodObject<Shape>>) => Promise<{ content: Content[] }>,
): void {
  server.registerTool(
    name,
    {
      title: config.title,
      description: config.description,
      inputSchema: config.inputSchema,
      annotations: { readOnlyHint: config.readOnly, openWorldHint: !config.readOnly },
    },
    (async (args: z.infer<z.ZodObject<Shape>>) => {
      try {
        return await run(args);
      } catch (cause) {
        return failure(cause);
      }
    }) as any,
  );
}

const timeFormat = new Intl.DateTimeFormat("sv-SE", {
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
});

function when(iso: string): string {
  return timeFormat.format(new Date(iso));
}

function who(message: StoredMessage, chatName: string): string {
  if (message.direction === "outbound") return message.origin === "agent" ? "You (sent via Claude)" : "You";
  return message.sender.endsWith("@g.us") || message.chatId.endsWith("@g.us") ? `${message.sender}` : chatName;
}

function formatMessage(message: StoredMessage, chatName: string): string {
  const attachment =
    message.kind !== "text"
      ? ` [${message.kind}${message.mediaFilename ? `: ${message.mediaFilename}` : ""}${
          message.savedFilePath ? `, saved at ${message.savedFilePath}` : message.mediaMimeType ? ", not downloaded" : ""
        }]`
      : "";
  const body = message.text ? ` ${message.text}` : "";
  return `[${when(message.occurredAt)}] ${who(message, chatName)}:${attachment}${body}  (id: ${message.id})`;
}

function formatChat(chat: StoredChat): string {
  const kind = chat.kind === "group" ? "group" : chat.kind === "direct" ? "contact" : "chat";
  const last = chat.lastActivityAt ? `, last activity ${when(chat.lastActivityAt)}` : "";
  return `- ${chat.name} (${kind}, chat id: ${chat.id}${last})`;
}

tool(
  "whatsapp_status",
  {
    title: "WhatsApp connection status",
    description:
      "Checks whether WhatsApp is connected. Starts the background WhatsApp service if needed. " +
      "When WhatsApp is not linked yet it returns the QR code image and opens a pairing page in the user's browser " +
      "(set open_pairing_window=false to skip that). Use restart=true if WhatsApp seems stuck.",
    inputSchema: {
      open_pairing_window: z.boolean().optional().describe("Open the QR pairing page in the browser when linking is needed. Default true."),
      restart: z.boolean().optional().describe("Restart the WhatsApp connection first."),
    },
    readOnly: false,
  },
  async ({ open_pairing_window, restart }) => {
    let state = await callService<PairingState>(restart ? "restart" : "status");
    // A fresh service needs a few seconds before WhatsApp reports its state.
    for (let wait = 0; wait < 20 && ["idle", "initializing", "authenticated"].includes(state.state); wait += 1) {
      await new Promise((resolve) => setTimeout(resolve, 1500));
      state = await callService<PairingState>("status");
    }
    if (state.state === "ready") {
      const account = state.linkedAccount;
      return text(`WhatsApp is connected${account ? ` as ${account.name ?? ""} ${account.number}`.trimEnd() : ""}.`);
    }
    if (state.state === "awaiting_qr" && state.qrImagePath) {
      const url = await pairingUrl();
      if (open_pairing_window !== false) openInBrowser(url);
      return {
        content: [
          {
            type: "text",
            text:
              "WhatsApp needs to be linked to this computer (only once). A page with the QR code was opened in the browser" +
              (open_pairing_window === false ? " (not opened this time)" : "") +
              `: ${url}\nAsk the user to open WhatsApp on their phone, go to Linked devices > Link a device, and scan the code. ` +
              "The code refreshes every ~20 seconds and the page updates by itself. Call whatsapp_status again after they scan it.",
          },
          { type: "image", data: readFileSync(state.qrImagePath).toString("base64"), mimeType: "image/png" },
        ],
      };
    }
    return text(
      `WhatsApp is not connected yet (state: ${state.state}${state.detail ? `, ${state.detail}` : ""}). ` +
        "Wait a little and call whatsapp_status again; if it stays this way, call it with restart=true.",
    );
  },
);

tool(
  "whatsapp_inbox",
  {
    title: "New WhatsApp messages",
    description:
      "Lists chats with incoming messages that have not been read through Claude yet (newest first), " +
      "including messages that arrived while Claude was closed. Reading a chat with whatsapp_read clears it from the inbox.",
    inputSchema: {},
    readOnly: true,
  },
  async () => {
    const entries = await callService<Array<{ chat: StoredChat; newMessages: number; latest: StoredMessage }>>("inbox");
    if (!entries.length) return text("No new messages.");
    return text(
      entries
        .map(
          (entry) =>
            `- ${entry.chat.name} (chat id: ${entry.chat.id}): ${entry.newMessages} new\n    last: ${formatMessage(entry.latest, entry.chat.name)}`,
        )
        .join("\n"),
    );
  },
);

tool(
  "whatsapp_find_chat",
  {
    title: "Find a WhatsApp chat",
    description: "Finds WhatsApp contacts or groups by part of their name or phone number. Returns chat ids.",
    inputSchema: { query: z.string().describe("Part of the name or number, e.g. 'Silva' or '11 98765'.") },
    readOnly: true,
  },
  async ({ query }) => {
    const chats = await callService<StoredChat[]>("findChat", { query });
    return text(chats.length ? chats.map(formatChat).join("\n") : `No chat matches "${query}".`);
  },
);

tool(
  "whatsapp_read",
  {
    title: "Read a WhatsApp chat",
    description:
      "Reads messages of one chat, oldest to newest. `chat` can be a chat id, a phone number (with country code), or a name. " +
      "To go further back, pass `before` = the time of the oldest message you already have (ISO format). " +
      "Attachments show as [document: name] etc.; use whatsapp_download_media to save them.",
    inputSchema: {
      chat: z.string(),
      limit: z.number().int().min(1).max(200).optional().describe("How many messages (default 30)."),
      before: z.string().optional().describe("ISO date-time; only messages before it."),
    },
    readOnly: true,
  },
  async ({ chat, limit, before }) => {
    const result = await callService<{ chat: StoredChat; messages: StoredMessage[]; warning?: string }>("read", {
      chat,
      limit,
      before,
    });
    const lines = result.messages.map((message) => formatMessage(message, result.chat.name));
    const oldest = result.messages[0];
    return text(
      [
        `Chat: ${result.chat.name} (chat id: ${result.chat.id})`,
        result.warning ? `Note: ${result.warning}` : "",
        lines.length ? lines.join("\n") : "No messages found.",
        oldest ? `(To see older messages, use before="${oldest.occurredAt}".)` : "",
      ]
        .filter(Boolean)
        .join("\n"),
    );
  },
);

tool(
  "whatsapp_search",
  {
    title: "Search WhatsApp messages",
    description:
      "Keyword search over all WhatsApp messages saved on this computer (accents and case ignored; every word must appear). " +
      "Optionally limit to one chat.",
    inputSchema: {
      query: z.string(),
      chat: z.string().optional(),
      limit: z.number().int().min(1).max(100).optional(),
    },
    readOnly: true,
  },
  async ({ query, chat, limit }) => {
    const results = await callService<Array<StoredMessage & { chatName: string }>>("search", { query, chat, limit });
    if (!results.length) return text(`No messages contain "${query}".`);
    return text(results.map((message) => `${message.chatName}: ${formatMessage(message, message.chatName)}`).join("\n"));
  },
);

tool(
  "whatsapp_send",
  {
    title: "Send a WhatsApp message",
    description:
      "Sends a text message from the user's WhatsApp. This really sends to the client: only call it after the user approved the exact text. " +
      "`chat` can be a chat id, a phone number with country code, or a name. Use reply_to (a message id) to quote a specific message.",
    inputSchema: {
      chat: z.string(),
      text: z.string().min(1),
      reply_to: z.string().optional(),
    },
    readOnly: false,
  },
  async ({ chat, text: body, reply_to }) => {
    const result = await callService<{ messageId: string; chat: string }>("send", { chat, text: body, replyTo: reply_to });
    return text(`Sent to ${result.chat} (message id: ${result.messageId}).`);
  },
);

tool(
  "whatsapp_send_file",
  {
    title: "Send a file on WhatsApp",
    description:
      "Sends a file (PDF, Word, image, audio…) from this computer to a WhatsApp chat, with an optional caption. " +
      "Only call it after the user approved sending that file. Relative paths are relative to the project folder.",
    inputSchema: {
      chat: z.string(),
      path: z.string(),
      caption: z.string().optional(),
    },
    readOnly: false,
  },
  async ({ chat, path, caption }) => {
    const result = await callService<{ messageId: string; chat: string; file: string }>("sendFile", { chat, path, caption });
    return text(`Sent ${result.file} to ${result.chat} (message id: ${result.messageId}).`);
  },
);

tool(
  "whatsapp_download_media",
  {
    title: "Save a WhatsApp attachment",
    description:
      "Saves a document, photo, audio or video that someone sent on WhatsApp into a folder on this computer " +
      "(normally the client's folder, e.g. clients/Maria Silva/documents). Returns the saved path so you can read it.",
    inputSchema: {
      message_id: z.string(),
      folder: z.string().describe("Destination folder; relative paths are relative to the project folder."),
    },
    readOnly: false,
  },
  async ({ message_id, folder }) => {
    const result = await callService<{ savedTo: string; mimeType: string; bytes: number }>("downloadMedia", {
      messageId: message_id,
      folder,
    });
    return text(`Saved to ${result.savedTo} (${result.mimeType}, ${Math.ceil(result.bytes / 1024)} KB).`);
  },
);

tool(
  "whatsapp_alerts",
  {
    title: "WhatsApp alerts per client",
    description:
      "Shows or changes what happens when a client writes, per chat. Modes: " +
      "'off' (default, nothing happens); 'notify' (the lawyer gets a note in his own WhatsApp chat \"Message yourself\"); " +
      "'draft' (Claude prepares a reply in the background inside this client's conversation and sends it to the lawyer's own WhatsApp chat; " +
      "he answers 'ok' to send it, 'não' to discard, or says what to change. Nothing is sent without his OK). " +
      "Pass session_id (printed at session start) to link this client's Claude conversation, so background drafts continue it. " +
      "Call with no arguments to list every client that has alerts on.",
    inputSchema: {
      chat: z.string().optional(),
      mode: z.enum(["off", "notify", "draft"]).optional(),
      session_id: z.string().optional().describe("This conversation's session id, to link it to the client."),
      instructions: z.string().optional().describe("Standing instructions for drafts for this client, e.g. 'always formal'."),
    },
    readOnly: false,
  },
  async ({ chat, mode, session_id, instructions }) => {
    if (!chat) {
      const list = await callService<Array<{ name: string; chatId: string; mode: string; sessionId?: string }>>("listAlerts");
      return text(
        list.length
          ? list.map((item) => `- ${item.name} (${item.chatId}): ${item.mode}${item.sessionId ? ", linked to a conversation" : ""}`).join("\n")
          : "No client has alerts on.",
      );
    }
    if (!mode) {
      const current = await callService<{ chatId: string; mode: string }>("getAlert", { chat });
      return text(`${current.chatId}: ${current.mode}`);
    }
    const setting = await callService<{ chatId: string; mode: string; sessionId?: string }>("setAlerts", {
      chat,
      mode,
      sessionId: session_id,
      instructions,
    });
    return text(`Alerts for ${setting.chatId} set to ${setting.mode}${setting.sessionId ? " (linked to a conversation)" : ""}.`);
  },
);

tool(
  "whatsapp_watch",
  {
    title: "Follow a client live in this conversation",
    description:
      "Only works when Claude was started with the live launcher (start-live). Makes this conversation receive new WhatsApp " +
      "messages from one chat as they arrive (pass chat), or from every client with alerts on (chat='all', the default).",
    inputSchema: { chat: z.string() },
    readOnly: false,
  },
  async ({ chat }) => {
    if (!LIVE) {
      return text(
        "Live messages are not active in this conversation (Claude was not started with the live launcher). " +
          "Alerts set with whatsapp_alerts still work.",
      );
    }
    if (chat === "all") {
      watching = "alerts";
      return text("This conversation now receives new messages from every client with alerts on.");
    }
    const found = await callService<{ chatId: string }>("getAlert", { chat });
    watching = found.chatId;
    return text(`This conversation now receives new messages from ${found.chatId} as they arrive.`);
  },
);

function describeEvent(event: LiveEvent): string {
  const attachment = event.kind !== "text" ? ` [${event.kind}${event.mediaFilename ? `: ${event.mediaFilename}` : ""}]` : "";
  return `New WhatsApp message from ${event.chatName} (chat id ${event.chatId}) at ${when(event.occurredAt)}:${attachment} ${event.text}`.trim();
}

/** Long-polls the background service and pushes client messages into this Claude session. */
async function relayLiveMessages(): Promise<void> {
  const session = randomUUID();
  let after: number | undefined;
  for (;;) {
    try {
      const info = await ensureService();
      const query = new URLSearchParams({ session, watch: watching, wait: "25000", ...(after !== undefined ? { after: String(after) } : {}) });
      const response = await fetch(`http://127.0.0.1:${info.port}/events?${query}`, {
        headers: { authorization: `Bearer ${info.token}` },
        signal: AbortSignal.timeout(40_000),
      });
      const body = (await response.json()) as { events: LiveEvent[]; latest: number };
      for (const event of body.events) {
        const relevant = watching === "alerts" ? event.alertMode !== "off" : event.chatId === watching;
        if (!relevant) continue;
        await server.server.notification({
          method: "notifications/claude/channel",
          params: {
            content: describeEvent(event),
            meta: { chat_id: event.chatId, chat_name: event.chatName, message_id: event.messageId },
          },
        });
      }
      after = body.latest;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 5000));
    }
  }
}

await server.connect(new StdioServerTransport());
if (LIVE) void relayLiveMessages();

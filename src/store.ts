import { DatabaseSync } from "node:sqlite";
import type { DiscoveredChat, NormalizedMessage } from "./domain.ts";

export interface StoredMessage {
  readonly id: string;
  readonly chatId: string;
  readonly sender: string;
  readonly direction: "inbound" | "outbound";
  readonly origin: string;
  readonly kind: string;
  readonly text: string;
  readonly occurredAt: string;
  readonly quotedId?: string;
  readonly mediaMimeType?: string;
  readonly mediaFilename?: string;
  readonly mediaSizeBytes?: number;
  readonly savedFilePath?: string;
}

export interface StoredChat {
  readonly id: string;
  readonly name: string;
  readonly kind: string;
  readonly lastActivityAt?: string;
  readonly lastCheckedAt?: string;
}

export interface InboxEntry {
  readonly chat: StoredChat;
  readonly newMessages: number;
  readonly latest: StoredMessage;
}

/**
 * Local message archive. Every message the WhatsApp service sees is kept here,
 * so Claude can read and search history even for messages that arrived while
 * no Claude session was open.
 */
export class MessageStore {
  private readonly db: DatabaseSync;

  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS chats (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        kind TEXT NOT NULL DEFAULT 'unknown',
        last_activity_at TEXT,
        last_checked_at TEXT
      );
      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY,
        chat_id TEXT NOT NULL,
        sender TEXT NOT NULL,
        direction TEXT NOT NULL,
        origin TEXT NOT NULL,
        kind TEXT NOT NULL,
        text TEXT NOT NULL,
        occurred_at TEXT NOT NULL,
        quoted_id TEXT,
        media_mime_type TEXT,
        media_filename TEXT,
        media_size_bytes INTEGER,
        saved_file_path TEXT
      );
      CREATE TABLE IF NOT EXISTS chat_aliases (
        alias TEXT PRIMARY KEY,
        canonical TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS messages_chat_time ON messages (chat_id, occurred_at);
      CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
        text, content='messages', content_rowid='rowid', tokenize='unicode61 remove_diacritics 2'
      );
      CREATE TRIGGER IF NOT EXISTS messages_ai AFTER INSERT ON messages BEGIN
        INSERT INTO messages_fts(rowid, text) VALUES (new.rowid, new.text);
      END;
      CREATE TRIGGER IF NOT EXISTS messages_ad AFTER DELETE ON messages BEGIN
        INSERT INTO messages_fts(messages_fts, rowid, text) VALUES ('delete', old.rowid, old.text);
      END;
    `);
  }

  close(): void {
    this.db.close();
  }

  /** node:sqlite rejects undefined and objects; WhatsApp Web sometimes hands us both. */
  private run(sql: string, ...params: unknown[]) {
    return this.db.prepare(sql).run(...params.map(bindable));
  }

  private get(sql: string, ...params: unknown[]): Row | undefined {
    return this.db.prepare(sql).get(...params.map(bindable)) as Row | undefined;
  }

  private all(sql: string, ...params: unknown[]): Row[] {
    return this.db.prepare(sql).all(...params.map(bindable)) as Row[];
  }

  lidChatIds(): string[] {
    return this.all("SELECT id FROM chats WHERE id LIKE '%@lid'").map((row) => String(row.id));
  }

  canonicalFor(alias: string): string | undefined {
    return this.get("SELECT canonical FROM chat_aliases WHERE alias = ?", alias)?.canonical as string | undefined;
  }

  aliasesOf(canonical: string): string[] {
    return this.all("SELECT alias FROM chat_aliases WHERE canonical = ?", canonical).map((row) => String(row.alias));
  }

  /** Records that `alias` is another ID for `canonical` and moves anything saved under it. */
  addAlias(alias: string, canonical: string): void {
    if (alias === canonical) return;
    this.db.exec("BEGIN");
    try {
      this.run("INSERT OR REPLACE INTO chat_aliases (alias, canonical) VALUES (?, ?)", alias, canonical);
      this.run("UPDATE OR IGNORE messages SET chat_id = ? WHERE chat_id = ?", canonical, alias);
      this.run("UPDATE messages SET sender = ? WHERE sender = ?", canonical, alias);
      const old = this.get("SELECT * FROM chats WHERE id = ?", alias);
      if (old) {
        this.run(
          `INSERT INTO chats (id, name, kind, last_activity_at, last_checked_at) VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET
             name = CASE WHEN chats.name LIKE '+%' THEN excluded.name ELSE chats.name END,
             kind = CASE WHEN chats.kind = 'unknown' THEN excluded.kind ELSE chats.kind END,
             last_activity_at = max(coalesce(chats.last_activity_at, ''), coalesce(excluded.last_activity_at, '')),
             last_checked_at = max(coalesce(chats.last_checked_at, ''), coalesce(excluded.last_checked_at, ''))`,
          canonical, old.name, old.kind, old.last_activity_at, old.last_checked_at,
        );
        this.run("DELETE FROM chats WHERE id = ?", alias);
      }
      this.db.exec("COMMIT");
    } catch (cause) {
      this.db.exec("ROLLBACK");
      throw cause;
    }
  }

  /** Returns true when the message was new. */
  saveMessage(message: NormalizedMessage): boolean {
    if (!message.providerMessageId || !message.chatExternalId) return false;
    const result = this.run(
      `INSERT OR IGNORE INTO messages
        (id, chat_id, sender, direction, origin, kind, text, occurred_at,
         quoted_id, media_mime_type, media_filename, media_size_bytes)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      message.providerMessageId,
      message.chatExternalId,
      message.senderExternalId,
      message.direction,
      message.origin,
      message.kind,
      message.text ?? "",
      message.occurredAt,
      message.quotedProviderMessageId,
      message.media?.mimeType,
      message.media?.filename,
      message.media?.sizeBytes,
    );
    this.run(
      `INSERT INTO chats (id, name, last_activity_at) VALUES (?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET last_activity_at =
         max(coalesce(chats.last_activity_at, ''), excluded.last_activity_at)`,
      message.chatExternalId,
      displayNameFromId(String(message.chatExternalId)),
      message.occurredAt,
    );
    return Number(result.changes) > 0;
  }

  saveChat(chat: DiscoveredChat): void {
    if (!chat.chatExternalId) return;
    this.run(
      `INSERT INTO chats (id, name, kind, last_activity_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET name = excluded.name, kind = excluded.kind,
         last_activity_at = max(coalesce(chats.last_activity_at, ''), coalesce(excluded.last_activity_at, ''))`,
      chat.chatExternalId,
      chat.displayName,
      chat.kind,
      chat.lastActivityAt,
    );
  }

  getChat(id: string): StoredChat | undefined {
    const row = this.get("SELECT * FROM chats WHERE id = ?", id);
    return row ? toChat(row) : undefined;
  }

  findChats(text: string, limit = 20): StoredChat[] {
    const pattern = `%${text.trim().toLocaleLowerCase()}%`;
    return this.all(
      `SELECT * FROM chats WHERE lower(name) LIKE ? OR id LIKE ?
       ORDER BY last_activity_at DESC LIMIT ?`,
      pattern,
      pattern,
      limit,
    ).map(toChat);
  }

  latestMessageAt(chatId: string): string | undefined {
    const row = this.get("SELECT max(occurred_at) AS at FROM messages WHERE chat_id = ?", chatId);
    return (row?.at as string | null) ?? undefined;
  }

  countMessages(chatId: string): number {
    return Number(this.get("SELECT count(*) AS n FROM messages WHERE chat_id = ?", chatId)?.n ?? 0);
  }

  /** Newest `limit` messages before `before` (exclusive), returned oldest first. */
  readMessages(chatId: string, limit: number, before?: string): StoredMessage[] {
    return this.all(
      `SELECT * FROM messages WHERE chat_id = ? AND occurred_at < ?
       ORDER BY occurred_at DESC, rowid DESC LIMIT ?`,
      chatId,
      before ?? "9999",
      limit,
    )
      .map(toMessage)
      .reverse();
  }

  getMessage(id: string): StoredMessage | undefined {
    const row = this.get("SELECT * FROM messages WHERE id = ?", id);
    return row ? toMessage(row) : undefined;
  }

  markChecked(chatId: string, at: string): void {
    this.run("UPDATE chats SET last_checked_at = ? WHERE id = ?", at, chatId);
  }

  setSavedFilePath(messageId: string, path: string): void {
    this.run("UPDATE messages SET saved_file_path = ? WHERE id = ?", path, messageId);
  }

  /** Chats with inbound messages Claude has not looked at yet. */
  inbox(limit = 30): InboxEntry[] {
    const rows = this.all(
      `SELECT c.*, count(m.id) AS new_messages, max(m.occurred_at) AS newest
       FROM chats c JOIN messages m ON m.chat_id = c.id
       WHERE m.direction = 'inbound' AND m.occurred_at > coalesce(c.last_checked_at, '')
       GROUP BY c.id ORDER BY newest DESC LIMIT ?`,
      limit,
    );
    return rows.map((row) => {
      const chat = toChat(row);
      const [latest] = this.readMessages(chat.id, 1);
      return { chat, newMessages: Number(row.new_messages), latest: latest! };
    });
  }

  search(query: string, options: { chatId?: string; limit?: number } = {}): StoredMessage[] {
    const match = toFtsQuery(query);
    if (!match) return [];
    const limit = options.limit ?? 30;
    const sql = `SELECT m.* FROM messages_fts f JOIN messages m ON m.rowid = f.rowid
      WHERE messages_fts MATCH ? ${options.chatId ? "AND m.chat_id = ?" : ""}
      ORDER BY m.occurred_at DESC LIMIT ?`;
    const params = options.chatId ? [match, options.chatId, limit] : [match, limit];
    return this.all(sql, ...params).map(toMessage);
  }
}

/** Every word must appear (prefix match), so plain-language queries just work. */
function toFtsQuery(query: string): string {
  return query
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean)
    .map((word) => `"${word}"*`)
    .join(" ");
}

function displayNameFromId(id: string): string {
  const number = id.split("@")[0] ?? id;
  return /^\d+$/.test(number) ? `+${number}` : id;
}

type Row = Record<string, unknown>;
type Bindable = string | number | bigint | null | Uint8Array;

function bindable(value: unknown): Bindable {
  if (value === undefined || value === null) return null;
  if (typeof value === "string" || typeof value === "number" || typeof value === "bigint") return value;
  if (typeof value === "boolean") return value ? 1 : 0;
  if (value instanceof Uint8Array) return value;
  const serialized = (value as { _serialized?: unknown })._serialized;
  return typeof serialized === "string" ? serialized : JSON.stringify(value);
}

function optional<T>(value: unknown): T | undefined {
  return value === null || value === undefined ? undefined : (value as T);
}

function toChat(row: Row): StoredChat {
  return {
    id: String(row.id),
    name: String(row.name),
    kind: String(row.kind),
    ...withDefined({
      lastActivityAt: optional<string>(row.last_activity_at) || undefined,
      lastCheckedAt: optional<string>(row.last_checked_at),
    }),
  };
}

function toMessage(row: Row): StoredMessage {
  return {
    id: String(row.id),
    chatId: String(row.chat_id),
    sender: String(row.sender),
    direction: row.direction as StoredMessage["direction"],
    origin: String(row.origin),
    kind: String(row.kind),
    text: String(row.text),
    occurredAt: String(row.occurred_at),
    ...withDefined({
      quotedId: optional<string>(row.quoted_id),
      mediaMimeType: optional<string>(row.media_mime_type),
      mediaFilename: optional<string>(row.media_filename),
      mediaSizeBytes: optional<number>(row.media_size_bytes),
      savedFilePath: optional<string>(row.saved_file_path),
    }),
  };
}

function withDefined<T extends Record<string, unknown>>(value: T): Partial<T> {
  return Object.fromEntries(
    Object.entries(value).filter(([, entry]) => entry !== undefined),
  ) as Partial<T>;
}

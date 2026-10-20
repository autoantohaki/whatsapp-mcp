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

  /** Returns true when the message was new. */
  saveMessage(message: NormalizedMessage): boolean {
    const result = this.db
      .prepare(
        `INSERT OR IGNORE INTO messages
          (id, chat_id, sender, direction, origin, kind, text, occurred_at,
           quoted_id, media_mime_type, media_filename, media_size_bytes)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        message.providerMessageId,
        message.chatExternalId,
        message.senderExternalId,
        message.direction,
        message.origin,
        message.kind,
        message.text,
        message.occurredAt,
        message.quotedProviderMessageId ?? null,
        message.media?.mimeType ?? null,
        message.media?.filename ?? null,
        message.media?.sizeBytes ?? null,
      );
    this.db
      .prepare(
        `INSERT INTO chats (id, name, last_activity_at) VALUES (?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET last_activity_at =
           max(coalesce(chats.last_activity_at, ''), excluded.last_activity_at)`,
      )
      .run(message.chatExternalId, displayNameFromId(message.chatExternalId), message.occurredAt);
    return Number(result.changes) > 0;
  }

  saveChat(chat: DiscoveredChat): void {
    this.db
      .prepare(
        `INSERT INTO chats (id, name, kind, last_activity_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET name = excluded.name, kind = excluded.kind,
           last_activity_at = max(coalesce(chats.last_activity_at, ''), coalesce(excluded.last_activity_at, ''))`,
      )
      .run(chat.chatExternalId, chat.displayName, chat.kind, chat.lastActivityAt ?? null);
  }

  getChat(id: string): StoredChat | undefined {
    const row = this.db.prepare("SELECT * FROM chats WHERE id = ?").get(id);
    return row ? toChat(row) : undefined;
  }

  findChats(text: string, limit = 20): StoredChat[] {
    const pattern = `%${text.trim().toLocaleLowerCase()}%`;
    return this.db
      .prepare(
        `SELECT * FROM chats WHERE lower(name) LIKE ? OR id LIKE ?
         ORDER BY last_activity_at DESC LIMIT ?`,
      )
      .all(pattern, pattern, limit)
      .map(toChat);
  }

  latestMessageAt(chatId: string): string | undefined {
    const row = this.db
      .prepare("SELECT max(occurred_at) AS at FROM messages WHERE chat_id = ?")
      .get(chatId);
    return (row?.at as string | null) ?? undefined;
  }

  countMessages(chatId: string): number {
    const row = this.db
      .prepare("SELECT count(*) AS n FROM messages WHERE chat_id = ?")
      .get(chatId);
    return Number(row?.n ?? 0);
  }

  /** Newest `limit` messages before `before` (exclusive), returned oldest first. */
  readMessages(chatId: string, limit: number, before?: string): StoredMessage[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM messages WHERE chat_id = ? AND occurred_at < ?
         ORDER BY occurred_at DESC, rowid DESC LIMIT ?`,
      )
      .all(chatId, before ?? "9999", limit);
    return rows.map(toMessage).reverse();
  }

  getMessage(id: string): StoredMessage | undefined {
    const row = this.db.prepare("SELECT * FROM messages WHERE id = ?").get(id);
    return row ? toMessage(row) : undefined;
  }

  markChecked(chatId: string, at: string): void {
    this.db.prepare("UPDATE chats SET last_checked_at = ? WHERE id = ?").run(at, chatId);
  }

  setSavedFilePath(messageId: string, path: string): void {
    this.db.prepare("UPDATE messages SET saved_file_path = ? WHERE id = ?").run(path, messageId);
  }

  /** Chats with inbound messages Claude has not looked at yet. */
  inbox(limit = 30): InboxEntry[] {
    const rows = this.db
      .prepare(
        `SELECT c.*, count(m.id) AS new_messages, max(m.occurred_at) AS newest
         FROM chats c JOIN messages m ON m.chat_id = c.id
         WHERE m.direction = 'inbound' AND m.occurred_at > coalesce(c.last_checked_at, '')
         GROUP BY c.id ORDER BY newest DESC LIMIT ?`,
      )
      .all(limit);
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
    return this.db.prepare(sql).all(...params).map(toMessage);
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

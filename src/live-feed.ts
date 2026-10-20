import type { AutopilotMode } from "./store.ts";

export interface LiveEvent {
  readonly seq: number;
  readonly chatId: string;
  readonly chatName: string;
  readonly alertMode: AutopilotMode;
  readonly messageId: string;
  readonly kind: string;
  readonly text: string;
  readonly occurredAt: string;
  readonly mediaFilename?: string;
}

interface Watcher {
  /** A chat id, or "alerts" for every chat with alerts turned on. */
  readonly watch: string;
  lastSeen: number;
}

const WATCHER_TTL_MS = 90_000;
const MAX_EVENTS = 500;

/**
 * Incoming client messages, kept briefly so open Claude sessions can pick
 * them up by long-polling (see the channel in mcp.ts).
 */
export class LiveFeed {
  private events: LiveEvent[] = [];
  private seq = 0;
  private readonly waiters = new Set<() => void>();
  private readonly watchers = new Map<string, Watcher>();

  push(event: Omit<LiveEvent, "seq">): void {
    this.seq += 1;
    this.events.push({ ...event, seq: this.seq });
    if (this.events.length > MAX_EVENTS) this.events = this.events.slice(-MAX_EVENTS);
    for (const wake of [...this.waiters]) wake();
  }

  latestSeq(): number {
    return this.seq;
  }

  /** Waits up to `timeoutMs` for events after `after`, and records who is listening. */
  async next(input: { after: number; session: string; watch: string; timeoutMs: number }): Promise<LiveEvent[]> {
    this.touch(input.session, input.watch);
    const pending = () => this.events.filter((event) => event.seq > input.after);
    if (!pending().length) {
      await new Promise<void>((resolve) => {
        const done = () => {
          clearTimeout(timer);
          this.waiters.delete(done);
          resolve();
        };
        const timer = setTimeout(done, input.timeoutMs);
        this.waiters.add(done);
      });
    }
    this.touch(input.session, input.watch);
    return pending();
  }

  /** True when an open Claude session will be told about this chat right now. */
  hasLiveWatcher(chatId: string, alertMode: AutopilotMode): boolean {
    const now = Date.now();
    for (const [session, watcher] of this.watchers) {
      if (now - watcher.lastSeen > WATCHER_TTL_MS) {
        this.watchers.delete(session);
        continue;
      }
      if (watcher.watch === chatId || (watcher.watch === "alerts" && alertMode !== "off")) return true;
    }
    return false;
  }

  private touch(session: string, watch: string): void {
    this.watchers.set(session, { watch, lastSeen: Date.now() });
  }
}

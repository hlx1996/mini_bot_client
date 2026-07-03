import { createReadStream, statSync } from "node:fs";
import { createInterface } from "node:readline";

interface ReplyResult {
  ok: boolean;
  text: string;
}

const PROGRESS_PATTERNS = [
  /^🤔\s/,
  /^⏳\s/,
  /^🔄\s/,
  /^⚡\s/,
  /^📝\s+正在/,
  /^🔍\s/,
  /^🚀\s/,
];

function isProgressMessage(text: string): boolean {
  return PROGRESS_PATTERNS.some((p) => p.test(text));
}

export class EventsTailer {
  private filePath: string;
  private position: number;

  constructor(filePath: string) {
    this.filePath = filePath;
    try {
      this.position = statSync(filePath).size;
    } catch {
      this.position = 0;
    }
  }

  async waitForReply(messageId: string, timeoutSec: number): Promise<ReplyResult> {
    const deadline = Date.now() + timeoutSec * 1000;
    const silenceWindow = 5000;
    let lastReplyTime = Date.now();
    let collectedText: string[] = [];

    while (Date.now() < deadline) {
      const newEvents = await this.readNewEvents();

      for (const evt of newEvents) {
        if (evt.kind !== "reply" || evt.to !== messageId) continue;

        const text = String(evt.text ?? "");
        if (isProgressMessage(text)) {
          lastReplyTime = Date.now();
          continue;
        }

        if (text.startsWith("❌") || text.startsWith("⚠️")) {
          return { ok: false, text };
        }

        collectedText.push(text);
        lastReplyTime = Date.now();
      }

      if (collectedText.length > 0 && Date.now() - lastReplyTime > silenceWindow) {
        return { ok: true, text: collectedText.join("\n") };
      }

      await sleep(500);
    }

    if (collectedText.length > 0) {
      return { ok: true, text: collectedText.join("\n") };
    }

    return { ok: false, text: `Timeout after ${timeoutSec}s waiting for reply` };
  }

  private async readNewEvents(): Promise<Record<string, unknown>[]> {
    const currentSize = statSync(this.filePath).size;
    if (currentSize <= this.position) {
      return [];
    }

    const events: Record<string, unknown>[] = [];
    const stream = createReadStream(this.filePath, {
      start: this.position,
      encoding: "utf-8",
    });

    const rl = createInterface({ input: stream });
    for await (const line of rl) {
      if (!line.trim()) continue;
      try {
        events.push(JSON.parse(line));
      } catch {
        // skip malformed lines
      }
    }

    this.position = currentSize;
    return events;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

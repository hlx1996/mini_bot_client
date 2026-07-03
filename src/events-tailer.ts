import { createReadStream, statSync, existsSync } from "node:fs";
import { createInterface } from "node:readline";
import { execFile } from "node:child_process";

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

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ── lark-cli based reply polling (network-independent) ──

async function fetchRepliesViaLarkCli(
  larkCliPath: string,
  chatId: string,
  messageId: string,
): Promise<string[]> {
  return new Promise((resolve, reject) => {
    execFile(
      larkCliPath,
      [
        "im", "+chat-messages-list",
        "--as", "bot",
        "--chat-id", chatId,
        "--order", "desc",
        "--page-size", "20",
        "--no-reactions",
      ],
      { timeout: 15_000 },
      (err, stdout) => {
        if (err) { resolve([]); return; }
        try {
          const result = JSON.parse(stdout.trim());
          if (!result.ok || !result.data?.messages) { resolve([]); return; }
          const replies: string[] = [];
          for (const msg of result.data.messages) {
            if (msg.reply_to !== messageId) continue;
            if (msg.sender?.sender_type !== "app") continue;
            const content = msg.content || "";
            replies.push(content);
          }
          resolve(replies.reverse());
        } catch {
          resolve([]);
        }
      },
    );
  });
}

async function waitForReplyViaLarkCli(
  larkCliPath: string,
  chatId: string,
  messageId: string,
  timeoutSec: number,
): Promise<ReplyResult> {
  const deadline = Date.now() + timeoutSec * 1000;
  const silenceWindow = 8000;
  let lastReplyTime = Date.now();
  let collectedText: string[] = [];
  let seenIds = new Set<string>();

  while (Date.now() < deadline) {
    const replies = await fetchRepliesViaLarkCli(larkCliPath, chatId, messageId);

    for (const text of replies) {
      const key = text.slice(0, 100);
      if (seenIds.has(key)) continue;
      seenIds.add(key);

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

    await sleep(3000);
  }

  if (collectedText.length > 0) {
    return { ok: true, text: collectedText.join("\n") };
  }
  return { ok: false, text: `Timeout after ${timeoutSec}s waiting for reply` };
}

// ── events.jsonl based reply polling (local only, faster) ──

async function waitForReplyViaEventsJsonl(
  filePath: string,
  messageId: string,
  timeoutSec: number,
): Promise<ReplyResult> {
  const deadline = Date.now() + timeoutSec * 1000;
  const silenceWindow = 5000;
  let lastReplyTime = Date.now();
  let collectedText: string[] = [];
  let position = 0;
  try { position = statSync(filePath).size; } catch {}

  while (Date.now() < deadline) {
    const currentSize = statSync(filePath).size;
    if (currentSize > position) {
      const stream = createReadStream(filePath, { start: position, encoding: "utf-8" });
      const rl = createInterface({ input: stream });
      for await (const line of rl) {
        if (!line.trim()) continue;
        try {
          const evt = JSON.parse(line);
          if (evt.kind !== "reply" || evt.to !== messageId) continue;
          const text = String(evt.text ?? "");
          if (isProgressMessage(text)) { lastReplyTime = Date.now(); continue; }
          if (text.startsWith("❌") || text.startsWith("⚠️")) return { ok: false, text };
          collectedText.push(text);
          lastReplyTime = Date.now();
        } catch {}
      }
      position = currentSize;
    }

    if (collectedText.length > 0 && Date.now() - lastReplyTime > silenceWindow) {
      return { ok: true, text: collectedText.join("\n") };
    }
    await sleep(500);
  }

  if (collectedText.length > 0) return { ok: true, text: collectedText.join("\n") };
  return { ok: false, text: `Timeout after ${timeoutSec}s waiting for reply` };
}

// ── Unified interface ──

export interface ReplyPollerConfig {
  mode: "auto" | "lark-cli" | "events-jsonl";
  larkCliPath?: string;
  chatId?: string;
  eventsPath?: string;
}

export async function waitForReply(
  messageId: string,
  timeoutSec: number,
  config: ReplyPollerConfig,
): Promise<ReplyResult> {
  let mode = config.mode;

  if (mode === "auto") {
    if (config.eventsPath && existsSync(config.eventsPath)) {
      mode = "events-jsonl";
    } else if (config.larkCliPath && config.chatId) {
      mode = "lark-cli";
    } else {
      return { ok: false, text: "No reply source configured (need eventsPath or larkCliPath+chatId)" };
    }
  }

  if (mode === "events-jsonl") {
    return waitForReplyViaEventsJsonl(config.eventsPath!, messageId, timeoutSec);
  }
  return waitForReplyViaLarkCli(config.larkCliPath!, config.chatId!, messageId, timeoutSec);
}

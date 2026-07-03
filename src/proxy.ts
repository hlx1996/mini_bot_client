#!/usr/bin/env node

import http from "node:http";
import { sendMessage } from "./lark-cli.js";
import { waitForReply } from "./events-tailer.js";

const PORT = parseInt(process.env.PORT || "9876", 10);
const DIRECT_URL = process.env.MINI_BOT_DIRECT_URL || "http://localhost:9877";
const CHAT_ID = process.env.MINI_BOT_CHAT_ID || "oc_7ea1907fb067c8d49a705c56591460d0";
const EVENTS_PATH = process.env.MINI_BOT_EVENTS_PATH || "";
const LARK_CLI = process.env.LARK_CLI_PATH || "/opt/homebrew/bin/lark-cli";
const DEFAULT_TIMEOUT = parseInt(process.env.MINI_BOT_TIMEOUT || "180", 10);

let directAvailable = false;
let requestLock: Promise<void> = Promise.resolve();

const replyConfig = {
  mode: "auto" as const,
  larkCliPath: LARK_CLI,
  chatId: CHAT_ID,
  eventsPath: EVENTS_PATH,
};

interface ChatMessage { role: string; content: string }
interface ChatRequest {
  model: string;
  messages: ChatMessage[];
  stream?: boolean;
  temperature?: number;
  max_tokens?: number;
}

function log(msg: string) {
  process.stderr.write(`[proxy] ${new Date().toISOString()} ${msg}\n`);
}

async function checkDirect(): Promise<boolean> {
  try {
    const url = new URL("/health", DIRECT_URL);
    const res = await fetch(url.toString(), { signal: AbortSignal.timeout(2000) });
    return res.ok;
  } catch {
    return false;
  }
}

async function handleDirect(req: ChatRequest, res: http.ServerResponse) {
  const url = new URL("/v1/chat/completions", DIRECT_URL);
  const upstream = await fetch(url.toString(), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(req),
  });

  if (!upstream.ok) {
    const text = await upstream.text();
    res.writeHead(upstream.status, { "Content-Type": "application/json" });
    res.end(text);
    return;
  }

  if (req.stream) {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });
    const reader = upstream.body!.getReader();
    const decoder = new TextDecoder();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      res.write(decoder.decode(value, { stream: true }));
    }
    res.end();
  } else {
    const text = await upstream.text();
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(text);
  }
}

async function handleLarkBridge(req: ChatRequest): Promise<Record<string, unknown>> {
  const model = req.model;
  const lastUserMsg = [...req.messages].reverse().find((m) => m.role === "user");
  if (!lastUserMsg?.content) throw new Error("No user message found");

  const prompt = lastUserMsg.content;
  const rawModel = model.startsWith("mb-") ? model.slice(3) : model;
  log(`lark-bridge model=${rawModel} prompt=${prompt.slice(0, 60)}...`);

  const switchMid = await sendMessage(LARK_CLI, CHAT_ID, `/model ${rawModel}`);
  const switchReply = await waitForReply(switchMid, 30, replyConfig);
  if (!switchReply.ok) log(`model switch warning: ${switchReply.text}`);

  const messageId = await sendMessage(LARK_CLI, CHAT_ID, prompt);
  log(`sent message_id=${messageId}, waiting for reply...`);

  const reply = await waitForReply(messageId, DEFAULT_TIMEOUT, replyConfig);
  const text = reply.ok ? reply.text : `Error: ${reply.text}`;
  log(`reply received (${text.length} chars)`);

  return {
    id: `chatcmpl-${Date.now()}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, message: { role: "assistant", content: text }, finish_reason: "stop" }],
    usage: { prompt_tokens: prompt.length, completion_tokens: text.length, total_tokens: prompt.length + text.length },
  };
}

const server = http.createServer(async (req, res) => {
  if (req.method === "GET" && req.url === "/health") {
    directAvailable = await checkDirect();
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: "ok", mode: directAvailable ? "direct" : "lark-bridge" }));
    return;
  }

  if (req.method === "GET" && req.url === "/v1/models") {
    try {
      if (directAvailable || await checkDirect()) {
        const url = new URL("/v1/models", DIRECT_URL);
        const upstream = await fetch(url.toString());
        const text = await upstream.text();
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(text);
        return;
      }
    } catch {}
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ object: "list", data: [] }));
    return;
  }

  if (req.method === "POST" && req.url === "/v1/chat/completions") {
    let body = "";
    for await (const chunk of req) body += chunk;

    const prevLock = requestLock;
    let releaseLock!: () => void;
    requestLock = new Promise<void>((r) => { releaseLock = r; });
    await prevLock;

    try {
      const parsed = JSON.parse(body) as ChatRequest;
      directAvailable = await checkDirect();

      if (directAvailable) {
        log(`routing: direct → ${DIRECT_URL}`);
        await handleDirect(parsed, res);
      } else {
        log(`routing: lark-bridge (API server unreachable)`);
        if (parsed.stream) {
          const result = await handleLarkBridge(parsed);
          const content = ((result.choices as any[])?.[0]?.message?.content) ?? "";
          const chatId = result.id as string;
          const created = result.created as number;
          const model = result.model as string;

          res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
          const chunkSize = 20;
          for (let i = 0; i < content.length; i += chunkSize) {
            const sseChunk = {
              id: chatId, object: "chat.completion.chunk", created, model,
              choices: [{ index: 0, delta: { content: content.slice(i, i + chunkSize) }, finish_reason: null }],
            };
            res.write(`data: ${JSON.stringify(sseChunk)}\n\n`);
          }
          res.write(`data: ${JSON.stringify({ id: chatId, object: "chat.completion.chunk", created, model, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n`);
          res.write("data: [DONE]\n\n");
          res.end();
        } else {
          const result = await handleLarkBridge(parsed);
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify(result));
        }
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      log(`ERROR: ${msg}`);
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: { message: msg, type: "server_error" } }));
    } finally {
      releaseLock();
    }
    return;
  }

  res.writeHead(404);
  res.end("Not Found");
});

server.listen(PORT, async () => {
  directAvailable = await checkDirect();
  log(`listening on http://localhost:${PORT}`);
  log(`mode: ${directAvailable ? "direct (API server reachable)" : "lark-bridge (API server unreachable)"}`);
});

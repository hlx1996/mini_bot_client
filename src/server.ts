#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { sendMessage } from "./lark-cli.js";
import { waitForReply } from "./events-tailer.js";

const CHAT_ID = process.env.MINI_BOT_CHAT_ID || "oc_7ea1907fb067c8d49a705c56591460d0";
const EVENTS_PATH = process.env.MINI_BOT_EVENTS_PATH || "";
const LARK_CLI = process.env.LARK_CLI_PATH || "/opt/homebrew/bin/lark-cli";

const server = new McpServer({
  name: "mini-bot",
  version: "1.0.0",
});

const replyConfig = {
  mode: "auto" as const,
  larkCliPath: LARK_CLI,
  chatId: CHAT_ID,
  eventsPath: EVENTS_PATH,
};

server.tool(
  "chat",
  "Send a message to mini_bot and wait for the AI reply. Use this to access any model mini_bot supports (qwen, deepseek, glm, kimi, etc.) via Feishu.",
  {
    message: z.string().describe("The message to send to the bot"),
    model: z.string().optional().describe("Model to switch to before sending (e.g. 'lite', 'fuyao-glm', 'qwen-max'). Omit to use current model."),
    timeout: z.number().optional().default(120).describe("Max seconds to wait for reply (default 120)"),
  },
  async ({ message, model, timeout }) => {
    try {
      if (model) {
        const switchMsg = `/model ${model}`;
        const switchMid = await sendMessage(LARK_CLI, CHAT_ID, switchMsg);
        const switchReply = await waitForReply(switchMid, 30, replyConfig);
        if (!switchReply.ok) {
          return { content: [{ type: "text", text: `Failed to switch model: ${switchReply.text}` }], isError: true };
        }
      }

      const messageId = await sendMessage(LARK_CLI, CHAT_ID, message);
      const reply = await waitForReply(messageId, timeout ?? 120, replyConfig);

      return {
        content: [{ type: "text", text: reply.ok ? reply.text : `Error: ${reply.text}` }],
        isError: !reply.ok,
      };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return { content: [{ type: "text", text: `Error: ${msg}` }], isError: true };
    }
  }
);

server.tool(
  "set_model",
  "Switch the mini_bot's active model. Available models include: lite, pro, qwen-max, deepseek-chat, fuyao-deepseek, fuyao-glm, fuyao-kimi, etc.",
  {
    model: z.string().describe("Model name to switch to"),
  },
  async ({ model }) => {
    try {
      const messageId = await sendMessage(LARK_CLI, CHAT_ID, `/model ${model}`);
      const reply = await waitForReply(messageId, 30, replyConfig);
      return {
        content: [{ type: "text", text: reply.ok ? reply.text : `Error: ${reply.text}` }],
        isError: !reply.ok,
      };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return { content: [{ type: "text", text: `Error: ${msg}` }], isError: true };
    }
  }
);

server.tool(
  "bot_status",
  "Check mini_bot's current status (model, host, quota, etc.)",
  {},
  async () => {
    try {
      const messageId = await sendMessage(LARK_CLI, CHAT_ID, "/status");
      const reply = await waitForReply(messageId, 30, replyConfig);
      return {
        content: [{ type: "text", text: reply.ok ? reply.text : `Error: ${reply.text}` }],
        isError: !reply.ok,
      };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return { content: [{ type: "text", text: `Error: ${msg}` }], isError: true };
    }
  }
);

server.tool(
  "reset_session",
  "Reset the mini_bot conversation session, clearing all memory/context.",
  {},
  async () => {
    try {
      const messageId = await sendMessage(LARK_CLI, CHAT_ID, "/reset");
      const reply = await waitForReply(messageId, 15, replyConfig);
      return {
        content: [{ type: "text", text: reply.ok ? reply.text : `Error: ${reply.text}` }],
        isError: !reply.ok,
      };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return { content: [{ type: "text", text: `Error: ${msg}` }], isError: true };
    }
  }
);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  process.stderr.write("mini-bot MCP server running on stdio\n");
}

main().catch((err) => {
  process.stderr.write(`Fatal: ${err}\n`);
  process.exit(1);
});

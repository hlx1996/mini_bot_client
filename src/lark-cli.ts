import { execFile } from "node:child_process";

export async function sendMessage(
  larkCliPath: string,
  chatId: string,
  text: string
): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      larkCliPath,
      ["im", "+messages-send", "--as", "user", "--chat-id", chatId, "--text", text],
      { timeout: 30_000 },
      (err, stdout, stderr) => {
        if (err) {
          reject(new Error(`lark-cli failed: ${stderr || err.message}`));
          return;
        }
        try {
          const result = JSON.parse(stdout.trim());
          if (!result.ok || !result.data?.message_id) {
            reject(new Error(`lark-cli returned no message_id: ${stdout}`));
            return;
          }
          resolve(result.data.message_id);
        } catch (e) {
          reject(new Error(`lark-cli parse error: ${stdout}`));
        }
      }
    );
  });
}

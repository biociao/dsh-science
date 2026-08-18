// mock-llm-server —— 模型路由 E2E 用的小型 OpenAI-completions 兼容桩服务器。
// 记录每个请求（method/url/model/messages）到 JSONL，返回固定文本补全。
// 用法：node scripts/mock-llm-server.mjs <portFile> <logFile>
//   portFile: 监听端口写入此文件（脚本用它等待就绪；port 0 自动分配）
//   logFile:  请求记录（每行一个 JSON）
import { createServer } from "node:http";
import { writeFileSync, appendFileSync } from "node:fs";

const portFile = process.argv[2] ?? "/tmp/mock-llm-port";
const logFile = process.argv[3] ?? "/tmp/mock-llm-requests.jsonl";

const server = createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    let parsed = null;
    try {
      parsed = JSON.parse(body);
    } catch {
      /* 记录原始 body */
    }
    appendFileSync(
      logFile,
      JSON.stringify({
        ts: Date.now(),
        method: req.method,
        url: req.url,
        model: parsed?.model ?? null,
        purpose: parsed?.purpose ?? null,
        messageCount: Array.isArray(parsed?.messages) ? parsed.messages.length : null,
        firstUserText: Array.isArray(parsed?.messages)
          ? (parsed.messages.find((m) => m.role === "user")?.content ?? "").toString().slice(0, 120)
          : null,
      }) + "\n"
    );
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        id: "mock-completion",
        object: "chat.completion",
        created: Math.floor(Date.now() / 1000),
        model: parsed?.model ?? "mock",
        choices: [
          {
            index: 0,
            message: { role: "assistant", content: "mock-title-ok" },
            finish_reason: "stop",
          },
        ],
      })
    );
  });
});

server.listen(0, "127.0.0.1", () => {
  const { port } = server.address();
  writeFileSync(portFile, String(port));
  console.log(`mock-llm-server listening on 127.0.0.1:${port}`);
});

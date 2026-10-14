// mock-llm.mjs — 本地假 LLM，验证抓题链路不依赖真实 API。
import http from "node:http";

const server = http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    const headers = {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "*",
      "Access-Control-Allow-Methods": "*",
    };
    if (req.method === "OPTIONS") {
      res.writeHead(204, headers);
      res.end();
      return;
    }
    const content = JSON.stringify({
      answer: "42",
      reasoning: "本地 mock：仅用于校验插件通道，1+1 的十进制结果是 2。",
    });
    res.writeHead(200, headers);
    res.end(JSON.stringify({ choices: [{ message: { role: "assistant", content } }] }));
  });
});

server.listen(8135, "127.0.0.1", () => console.log("mock llm on 8135"));

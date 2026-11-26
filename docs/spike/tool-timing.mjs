import { spawn } from "node:child_process";
import { homedir } from "node:os";
import path from "node:path";
const [, , CLAUDE, SPIKE] = process.argv;
const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !/^(CLAUDECODE$|CLAUDE_CODE_|CLAUDE_AGENT_)/.test(name)));
const args = ["-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose", "--include-partial-messages", "--settings", path.join(homedir(), ".claude", "tiers", "cheap.json"), "--tools", "", "--strict-mcp-config", "--mcp-config", path.join(SPIKE, "mcp.json"), "--permission-mode", "bypassPermissions"];
const child = spawn(CLAUDE, args, { cwd: path.join(SPIKE, "work"), env, stdio: ["pipe", "pipe", "pipe"] });
let buffer = "", sent = 0, id = "", done = () => {};
const seen = new Set();
child.stdout.on("data", (chunk) => {
  buffer += chunk;
  const lines = buffer.split("\n");
  buffer = lines.pop();
  for (const line of lines) {
    if (!line.trim()) continue;
    const event = JSON.parse(line);
    if (event.session_id) id = event.session_id;
    const inner = event.type === "stream_event" ? `s:${event.event?.type}` : `${event.type}:${event.subtype ?? ""}`;
    if (inner === "s:content_block_delta") continue;
    console.log(String(Date.now() - sent).padStart(6), inner, event.type === "assistant" ? event.message.content.map((block) => block.type + (block.name ? ":" + block.name : "")).join(",") : event.type === "user" ? "tool_result" : event.type === "rate_limit_event" ? "rate" : "");
    if (event.type === "result") done(event);
  }
});
const turn = (text) => new Promise((resolve) => { done = resolve; sent = Date.now(); child.stdin.write(JSON.stringify({ type: "user", session_id: id, message: { role: "user", content: [{ type: "text", text }] }, parent_tool_use_id: null }) + "\n"); });
await turn("只回复：好。");
console.log("--- tool 1");
await turn("调用 create_task，目标写“一”。完成后只回复：好。");
console.log("--- tool 2");
await turn("再调用 create_task，目标写“二”。完成后只回复：好。");
child.kill();
process.exit(0);

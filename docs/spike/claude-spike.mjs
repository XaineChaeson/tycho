// Measures the coordinator experience over Claude Code's bidirectional stream-json mode.
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

const [, , CLAUDE, SPIKE] = process.argv;
const WORK = path.join(SPIKE, "work");
const TIER = path.join(homedir(), ".claude", "tiers", "cheap.json");
const MCP = path.join(SPIKE, "mcp.json");
writeFileSync(MCP, JSON.stringify({ mcpServers: { ledger: { command: "node", args: [path.join(SPIKE, "mcp-stub.mjs")] } } }));
const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !/^(CLAUDECODE$|CLAUDE_CODE_|CLAUDE_AGENT_)/.test(name)));

function start(extra = []) {
  const args = ["-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose",
    "--include-partial-messages", "--settings", TIER, "--tools", "", "--strict-mcp-config",
    "--mcp-config", MCP, "--permission-mode", "bypassPermissions", ...extra];
  const child = spawn(CLAUDE, args, { cwd: WORK, env, stdio: ["pipe", "pipe", "pipe"] });
  const session = { child, id: null, tools: null, listeners: [], stderr: "" };
  let buffer = "";
  child.stdout.on("data", (chunk) => {
    buffer += chunk;
    const lines = buffer.split("\n");
    buffer = lines.pop();
    for (const line of lines) {
      if (!line.trim()) continue;
      let event;
      try { event = JSON.parse(line); } catch { continue; }
      if (event.session_id) session.id = event.session_id;
      if (event.type === "system" && event.subtype === "init") session.tools = event.tools;
      for (const listener of [...session.listeners]) listener(event);
    }
  });
  child.stderr.on("data", (chunk) => { session.stderr += chunk; });
  child.on("exit", (code) => { session.exit = code; });
  return session;
}
const say = (session, text) => session.child.stdin.write(JSON.stringify({ type: "user", session_id: session.id ?? "", message: { role: "user", content: [{ type: "text", text }] }, parent_tool_use_id: null }) + "\n");
const deltaOf = (event) => (event.type === "stream_event" && event.event?.type === "content_block_delta" && event.event.delta?.type === "text_delta" ? event.event.delta.text : null);

/** Sends a prompt and reports timing until the next result, optionally acting once the first text arrives. */
function turn(session, text, onFirstDelta) {
  return new Promise((resolve) => {
    const sent = Date.now();
    const report = { first: null, deltas: 0, chars: 0, tools: [], text: "" };
    const listener = (event) => {
      const delta = deltaOf(event);
      if (delta !== null) {
        if (report.first === null) { report.first = Date.now() - sent; onFirstDelta?.(); }
        report.deltas += 1; report.chars += delta.length; report.text += delta;
      }
      if (event.type === "assistant") for (const block of event.message?.content ?? []) if (block.type === "tool_use") report.tools.push(block.name);
      if (event.type === "result") {
        session.listeners.splice(session.listeners.indexOf(listener), 1);
        resolve({ ...report, total: Date.now() - sent, subtype: event.subtype, is_error: event.is_error, result: String(event.result ?? "").slice(0, 160), usage: event.usage && { in: event.usage.input_tokens, out: event.usage.output_tokens, cacheRead: event.usage.cache_read_input_tokens } });
      }
    };
    session.listeners.push(listener);
    say(session, text);
  });
}
const show = (name, value) => { const { text, ...rest } = value; console.log(name, JSON.stringify({ ...rest, text: text?.slice(-120) })); };
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const limit = (promise, ms, label) => Promise.race([promise, wait(ms).then(() => ({ timeout: label, text: "" }))]);

const a = start();
const cold = await limit(turn(a, "记住暗号：青松-7429。只回复“好的”。"), 120000, "cold");
show("A cold", cold);
console.log("A tools", JSON.stringify(a.tools), "session", a.id, "exit", a.exit, "stderr", a.stderr.slice(0, 400));
if (cold.timeout || cold.is_error) { a.child.kill(); process.exit(1); }
show("B warm", await limit(turn(a, "用一句话说明你现在能用哪些工具。"), 120000, "warm"));
show("C bash refused", await limit(turn(a, "请运行 shell 命令 whoami，告诉我结果。不能运行就直说。"), 120000, "bash"));
show("D mcp tool", await limit(turn(a, "调用 create_task 工具，目标写“验证流式”。然后用一句话回复。"), 120000, "mcp"));

// A message sent while a turn is streaming.
const appended = limit(turn(a, "写一段约 300 字的中文，介绍量化研究里的回测。", () => say(a, "补充要求：另起一行输出 APPEND-OK。")), 120000, "append");
show("E append during turn", await appended);
const second = await limit(new Promise((resolve) => {
  const report = { text: "" };
  const listener = (event) => {
    const delta = deltaOf(event);
    if (delta) report.text += delta;
    if (event.type === "result") { a.listeners.splice(a.listeners.indexOf(listener), 1); resolve({ ...report, result: String(event.result).slice(0, 120) }); }
  };
  a.listeners.push(listener);
}), 40000, "no second result");
show("E2 after append", second);

// Interrupt through the SDK control channel.
let interruptAt = 0;
const interrupted = turn(a, "从 1 数到 400，每个数字单独一行。", () => setTimeout(() => {
  interruptAt = Date.now();
  a.child.stdin.write(JSON.stringify({ type: "control_request", request_id: randomUUID(), request: { subtype: "interrupt" } }) + "\n");
}, 800));
const stopped = await limit(interrupted, 120000, "interrupt");
show("F interrupt", { ...stopped, stopLatency: Date.now() - interruptAt });
show("G after interrupt", await limit(turn(a, "只回复：还在。"), 120000, "after interrupt"));

// Crash, then resume.
const id = a.id;
a.child.kill();
await wait(1500);
const b = start(["--resume", id]);
show("H resume", await limit(turn(b, "刚才的暗号是什么？只回复暗号。"), 120000, "resume"));
console.log("H same session", b.id === id, b.id, "stderr", b.stderr.slice(0, 300));
b.child.kill();
process.exit(0);

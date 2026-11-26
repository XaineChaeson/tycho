// Measures the coordinator experience over Codex's app-server protocol.
import { spawn } from "node:child_process";
import path from "node:path";

const [, , SPIKE] = process.argv;
const WORK = path.join(SPIKE, "work");
const child = spawn("cmd.exe", ["/d", "/s", "/c", "codex app-server -c sandbox_mode=\"read-only\" -c approval_policy=\"never\""], { cwd: WORK, stdio: ["pipe", "pipe", "pipe"], windowsVerbatimArguments: true });
const pending = new Map();
let next = 1, buffer = "", stderr = "", onNote = () => {};
child.stderr.on("data", (chunk) => { stderr += chunk; });
child.stdout.on("data", (chunk) => {
  buffer += chunk;
  const lines = buffer.split("\n");
  buffer = lines.pop();
  for (const line of lines) {
    if (!line.trim()) continue;
    const message = JSON.parse(line);
    if (message.id !== undefined && !message.method) { pending.get(message.id)?.(message); pending.delete(message.id); }
    else if (message.method) onNote(message);
  }
});
const call = (method, params) => new Promise((resolve) => { const id = next++; pending.set(id, resolve); child.stdin.write(JSON.stringify({ id, method, params }) + "\n"); });
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const show = (name, value) => console.log(name, JSON.stringify(value).slice(0, 620));

show("init", await call("initialize", { clientInfo: { name: "spike", title: "spike", version: "0" } }));
child.stdin.write(JSON.stringify({ method: "initialized" }) + "\n");
const started = await call("thread/start", { cwd: WORK });
show("thread", { id: started.result?.thread?.id, error: started.error, model: started.result?.model });
const threadId = started.result?.thread?.id;
if (!threadId) { console.log(stderr.slice(0, 500)); child.kill(); process.exit(1); }

function run(name, prompt, act) {
  return new Promise(async (resolve) => {
    const sent = Date.now();
    const report = { first: null, deltas: 0, chars: 0, kinds: {}, text: "" };
    let turnId = null;
    onNote = (note) => {
      report.kinds[note.method] = (report.kinds[note.method] ?? 0) + 1;
      if (note.method === "turn/started") turnId = note.params.turn?.id ?? turnId;
      if (note.method === "item/agentMessage/delta") {
        if (report.first === null) { report.first = Date.now() - sent; act?.(turnId, sent); }
        report.deltas += 1; report.chars += note.params.delta.length; report.text += note.params.delta;
      }
      if (note.method === "turn/completed") {
        const { text, ...rest } = report;
        resolve({ ...rest, total: Date.now() - sent, status: note.params.turn?.status, error: note.params.turn?.error, tail: text.slice(-90) });
      }
    };
    const response = await call("turn/start", { threadId, input: [{ type: "text", text: prompt }] });
    if (response.error) resolve({ error: response.error });
    turnId = response.result?.turn?.id ?? turnId;
  });
}
show("A cold", await run("A", "记住暗号：青松-7429。只回复“好的”。"));
show("B warm", await run("B", "只回复：收到。"));
show("E steer", await run("E", "写一段约 300 字的中文，介绍量化研究里的回测。", (turnId) => {
  call("turn/steer", { threadId, expectedTurnId: turnId, input: [{ type: "text", text: "补充要求：最后另起一行输出 STEER-OK。" }] }).then((response) => show("steer ack", response.error ?? "ok"));
}));
show("F interrupt", await run("F", "写一篇约 1500 字的中文长文，介绍高频行情数据的存储设计。", (turnId, sent) => setTimeout(() => {
  console.log("interrupt at", Date.now() - sent);
  call("turn/interrupt", { threadId, turnId }).then((response) => show("interrupt ack", response.error ?? "ok"));
}, 1500)));
show("G after", await run("G", "刚才的暗号是什么？只回复暗号。"));
child.kill();
await wait(300);
process.exit(0);

// Checks whether dsh ACP delivers text incrementally, and whether cancel stops a running turn.
import { spawn } from "node:child_process";
import path from "node:path";

const [, , SPIKE] = process.argv;
const DSH = "D:\\software\\dsh\\resources\\runtime\\cli\\bin\\dsh.cmd";
const child = spawn("cmd.exe", ["/d", "/s", "/c", `"${DSH}" --profile acp`], { cwd: path.join(SPIKE, "work"), stdio: ["pipe", "pipe", "ignore"], windowsVerbatimArguments: true });
const pending = new Map();
let next = 1, buffer = "", onUpdate = () => {};
child.stdout.on("data", (chunk) => {
  buffer += chunk;
  const lines = buffer.split("\n");
  buffer = lines.pop();
  for (const line of lines) {
    if (!line.trim()) continue;
    const message = JSON.parse(line);
    if (message.id !== undefined && !message.method) { pending.get(message.id)?.(message); pending.delete(message.id); }
    else if (message.method === "session/update") onUpdate(message.params.update);
  }
});
const call = (method, params) => new Promise((resolve) => { const id = next++; pending.set(id, resolve); child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n"); });
const cancel = (sessionId) => child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "session/cancel", params: { sessionId } }) + "\n");

await call("initialize", { protocolVersion: 1, clientCapabilities: {} });
const { result: { sessionId, configOptions } } = await call("session/new", { cwd: path.join(SPIKE, "work"), mcpServers: [] });
const account = configOptions.find((option) => option.id === "model").options.find((group) => group.group === "deepseek-account").options[0];
await call("session/set_config_option", { sessionId, configId: "model", value: account.value });

async function run(name, prompt, cancelAfter) {
  const sent = Date.now();
  const arrivals = [];
  let chars = 0, timer;
  onUpdate = (update) => {
    if (update.sessionUpdate === "agent_message_chunk" || update.sessionUpdate === "agent_thought_chunk") {
      arrivals.push([update.sessionUpdate === "agent_thought_chunk" ? "T" : "M", Date.now() - sent, update.content?.text?.length ?? 0]);
      chars += update.content?.text?.length ?? 0;
      if (cancelAfter && !timer) timer = setTimeout(() => { console.log(name, "cancel at", Date.now() - sent); cancel(sessionId); }, cancelAfter);
    }
  };
  if (cancelAfter) timer = setTimeout(() => { console.log(name, "cancel at", Date.now() - sent); cancel(sessionId); }, cancelAfter);
  const response = await call("session/prompt", { sessionId, prompt: [{ type: "text", text: prompt }] });
  clearTimeout(timer);
  console.log(name, JSON.stringify({ total: Date.now() - sent, stop: response.result?.stopReason, error: response.error?.message, chars, updates: arrivals.length, sample: arrivals.slice(0, 8), last: arrivals.slice(-2) }));
}
await run("long", "写一篇约 600 字的中文短文，介绍量化研究里的回测流程。");
await run("cancel", "写一篇约 1500 字的中文长文，介绍高频行情数据的存储设计。", 2500);
await run("next", "只回复：还在。");
child.kill();
process.exit(0);

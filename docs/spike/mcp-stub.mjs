// Minimal stdio MCP server exposing one orchestration tool, so a restricted coordinator has something to call.
import readline from "node:readline";
const send = (message) => process.stdout.write(JSON.stringify(message) + "\n");
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const { id, method, params } = JSON.parse(line);
  if (method === "initialize") {
    const serverInfo = { name: "ledger", version: "0" };
    send({ jsonrpc: "2.0", id, result: { protocolVersion: params.protocolVersion, capabilities: { tools: {} }, serverInfo } });
  } else if (method === "tools/list") {
    const schema = { type: "object", properties: { goal: { type: "string" } }, required: ["goal"] };
    send({ jsonrpc: "2.0", id, result: { tools: [{ name: "create_task", description: "Create a task in the ledger", inputSchema: schema }] } });
  } else if (method === "tools/call") {
    send({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: `task-1 created: ${params.arguments.goal}` }] } });
  } else if (id !== undefined) {
    send({ jsonrpc: "2.0", id, result: {} });
  }
});

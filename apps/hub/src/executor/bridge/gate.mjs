// Serveur MCP stdio « studio » : un seul outil, permission_gate, utilisé par
// Claude Code (--permission-prompt-tool) pour les actions hors plan.
// Il transmet la demande au hub et attend votre réponse. Échec fermé.
// Usage : node gate.mjs <url /api/agent/runs/RUN-xxxx>   (jeton dans STUDIO_RUN_TOKEN)
import { createInterface } from "node:readline";

const url = process.argv[2];
const send = (o) => process.stdout.write(JSON.stringify(o) + "\n");
const TOOL = {
  name: "permission_gate",
  description: "Demande au directeur créatif l'autorisation d'une action non prévue dans le plan validé.",
  inputSchema: {
    type: "object",
    properties: { tool_name: { type: "string" }, input: { type: "object" }, tool_use_id: { type: "string" } },
    required: ["tool_name", "input"],
  },
};

async function ask(toolName, input) {
  try {
    const res = await fetch(`${url}/permission`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${process.env.STUDIO_RUN_TOKEN ?? ""}` },
      body: JSON.stringify({ tool_name: toolName, tool_input: input ?? {} }),
      signal: AbortSignal.timeout(20 * 60_000),
    });
    if (!res.ok) return { behavior: "deny", message: `Refusé (hub ${res.status}).` };
    const v = await res.json();
    if (v.behavior === "allow") return { behavior: "allow", updatedInput: input ?? {} };
    return { behavior: "deny", message: v.message ?? "Refusé par le directeur créatif." };
  } catch (err) {
    return { behavior: "deny", message: `Refusé par sécurité (${err?.message ?? err}).` };
  }
}

createInterface({ input: process.stdin }).on("line", async (line) => {
  if (!line.trim()) return;
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }
  if (msg.method === "initialize") {
    send({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: msg.params?.protocolVersion ?? "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "studio", version: "0.1.0" } } });
  } else if (msg.method === "tools/list") {
    send({ jsonrpc: "2.0", id: msg.id, result: { tools: [TOOL] } });
  } else if (msg.method === "tools/call") {
    const args = msg.params?.arguments ?? {};
    const verdict = msg.params?.name === TOOL.name ? await ask(args.tool_name, args.input) : { behavior: "deny", message: "Outil inconnu." };
    send({ jsonrpc: "2.0", id: msg.id, result: { content: [{ type: "text", text: JSON.stringify(verdict) }] } });
  } else if (msg.id !== undefined) {
    send({ jsonrpc: "2.0", id: msg.id, result: {} });
  }
});

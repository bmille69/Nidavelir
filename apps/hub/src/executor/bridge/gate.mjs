// Serveur MCP stdio « studio » : permission_gate, utilisé par Claude Code
// (--permission-prompt-tool) pour les actions hors plan : il transmet la demande au hub et attend
// votre réponse. Échec fermé. Pour le testeur (STUDIO_PLAY=1), aussi « jouer » : la manette (ADR-69).
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

const STEP = {
  type: "object",
  properties: {
    do: { type: "string", enum: ["click", "press", "type", "wait", "bridge"] },
    x: { type: "number" },
    y: { type: "number" },
    text: { type: "string", description: "click : texte du bouton ou de l'élément ; type : texte à écrire" },
    selector: { type: "string", description: "click : sélecteur CSS" },
    key: { type: "string", description: "press : ArrowLeft, ArrowUp, Space, Enter, Escape, a, z…" },
    hold_ms: { type: "number", description: "press : maintenir la touche (0 à 5000 ms)" },
    ms: { type: "number", description: "wait : 0 à 5000 ms" },
    method: { type: "string", enum: ["reset", "setSeed", "step"], description: "bridge : méthode de window.__STUDIO_TEST__" },
    value: { type: "number" },
  },
  required: ["do"],
};
const PLAY = {
  name: "jouer",
  description:
    "Joue au jeu de ce chantier dans un navigateur invisible, comme un joueur. action=open lance le jeu (screen pc ou phone) ; act joue jusqu'à 20 étapes d'affilée (clic, touche, texte, attente, pont de test) puis rend l'état de la page ; capture prend une photo ; close ferme la partie. Chaque réponse donne le texte visible, les boutons (avec leurs coordonnées), les zones de jeu, les nouvelles erreurs et l'état exposé par le jeu.",
  inputSchema: {
    type: "object",
    properties: {
      action: { type: "string", enum: ["open", "act", "capture", "close"] },
      screen: { type: "string", enum: ["pc", "phone"], description: "pc 1280×720 (défaut) ou téléphone 390×844 tactile ; en changer relance le jeu" },
      path: { type: "string", description: "open : ajouté à l'adresse du jeu (« ?niveau=2 »)" },
      steps: { type: "array", items: STEP, maxItems: 20 },
      capture: { type: "boolean", description: "act : prendre une photo après les étapes" },
    },
    required: ["action"],
  },
};
const TOOLS = process.env.STUDIO_PLAY === "1" ? [TOOL, PLAY] : [TOOL];

async function play(args) {
  try {
    const res = await fetch(`${url}/play`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${process.env.STUDIO_RUN_TOKEN ?? ""}` },
      body: JSON.stringify(args ?? {}),
      signal: AbortSignal.timeout(3 * 60_000),
    });
    const v = await res.json().catch(() => ({}));
    if (!res.ok) return { content: [{ type: "text", text: `Refusé (hub ${res.status}) : ${v.error ?? ""}` }], isError: true };
    const content = [{ type: "text", text: String(v.text ?? "") }];
    if (v.image?.data) content.push({ type: "image", data: v.image.data, mimeType: v.image.mimeType ?? "image/jpeg" });
    return { content };
  } catch (err) {
    return { content: [{ type: "text", text: `Le hub ne répond pas (${err?.message ?? err}).` }], isError: true };
  }
}

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
    send({ jsonrpc: "2.0", id: msg.id, result: { tools: TOOLS } });
  } else if (msg.method === "tools/call") {
    const args = msg.params?.arguments ?? {};
    if (msg.params?.name === PLAY.name && TOOLS.includes(PLAY)) return send({ jsonrpc: "2.0", id: msg.id, result: await play(args) });
    const verdict = msg.params?.name === TOOL.name ? await ask(args.tool_name, args.input) : { behavior: "deny", message: "Outil inconnu." };
    send({ jsonrpc: "2.0", id: msg.id, result: { content: [{ type: "text", text: JSON.stringify(verdict) }] } });
  } else if (msg.id !== undefined) {
    send({ jsonrpc: "2.0", id: msg.id, result: {} });
  }
});

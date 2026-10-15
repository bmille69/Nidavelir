// Hook PreToolUse de Claude Code : demande au hub une décision pour CHAQUE action.
// Échec fermé : toute erreur, absence de jeton ou hub muet = refus.
// Usage : node hook.mjs <url /api/agent/runs/RUN-xxxx>   (jeton dans STUDIO_RUN_TOKEN)
import { readFileSync } from "node:fs";

const url = process.argv[2];
const out = (decision, reason) => {
  process.stdout.write(
    JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: decision, permissionDecisionReason: `Game Studio Hub : ${reason}` } }),
  );
  process.exit(0);
};

try {
  const input = JSON.parse(readFileSync(0, "utf8"));
  const res = await fetch(`${url}/pretool`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${process.env.STUDIO_RUN_TOKEN ?? ""}` },
    // Dossier courant du terminal de l'agent : il persiste d'une commande à l'autre (ADR-38).
    body: JSON.stringify({ tool_name: input.tool_name, tool_input: input.tool_input ?? {}, cwd: typeof input.cwd === "string" ? input.cwd : undefined }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) out("deny", `refus (hub ${res.status})`);
  const { decision, reason } = await res.json();
  if (decision !== "allow" && decision !== "ask" && decision !== "deny") out("deny", "réponse du hub invalide");
  out(decision, reason);
} catch (err) {
  out("deny", `refus par sécurité (${err?.message ?? err})`);
}

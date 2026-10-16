import type { AgentId, AgentState, HubEvent } from "../api.ts";

export const AGENTS: Record<AgentId, { name: string; role: string; tagline: string; idle: string }> = {
  you: {
    name: "Vous",
    role: "Directeur créatif",
    tagline: "Vous décidez. Rien n'entre dans le jeu sans votre accord.",
    idle: "Rien ne vous attend. Profitez-en pour lancer une idée.",
  },
  concepteur: {
    name: "Le Concepteur",
    role: "Game design · conception",
    tagline: "Transforme une idée floue en dossier de conception et en premiers chantiers.",
    idle: "Prêt pour un nouveau projet.",
  },
  director: {
    name: "Le Directeur",
    role: "Chef d'équipe IA",
    tagline: "Discute avec vous et transforme vos idées en propositions claires.",
    idle: "Prêt à discuter.",
  },
  art_director: {
    name: "Le Directeur artistique",
    role: "Direction artistique",
    tagline: "Tient la bible visuelle, propose les visuels, juge les rendus et les fait brancher dans le jeu.",
    idle: "Prêt à regarder vos inspirations.",
  },
  archivist: {
    name: "L'Archiviste",
    role: "Mémoire du jeu",
    tagline: "Lit vos documents et vos messages, et note chaque idée sur une fiche.",
    idle: "Les fiches sont rangées.",
  },
  developer: {
    name: "Le Développeur",
    role: "Code · Claude Code",
    tagline: "Propose un plan, puis code dans une copie de votre jeu.",
    idle: "En attente d'une tâche.",
  },
  qa: {
    name: "Le Testeur",
    role: "Contrôle qualité",
    tagline: "Vérifie le travail du développeur et lance les tests du jeu.",
    idle: "Rien à vérifier pour l'instant.",
  },
  guardian: {
    name: "Le Gardien",
    role: "Sécurité",
    tagline: "Surveille chaque action du développeur et vous demande en cas de doute.",
    idle: "Monte la garde.",
  },
};

export const STATE_LABEL: Record<AgentState, string> = { idle: "Au repos", working: "Au travail", waiting: "Vous attend" };
export const YOU_STATE_LABEL: Record<AgentState, string> = { idle: "Tout est à jour", working: "", waiting: "À vous de jouer" };

/** Depuis combien de temps, en clair. */
export function since(iso: string | undefined, now: number): string {
  if (!iso) return "";
  const s = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
  if (s < 60) return `depuis ${s} s`;
  if (s < 3600) return `depuis ${Math.round(s / 60)} min`;
  return `depuis ${Math.round(s / 3600)} h`;
}

export function ago(iso: string, now: number): string {
  const s = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
  if (s < 60) return "à l'instant";
  if (s < 3600) return `il y a ${Math.round(s / 60)} min`;
  if (s < 86400) return `il y a ${Math.round(s / 3600)} h`;
  return new Date(iso).toLocaleDateString("fr-FR", { day: "numeric", month: "short" });
}

const AUTONOMY_LABEL: Record<string, string> = { supervised: "je valide tout", balanced: "équilibré", autonomous: "autonome" };
const MODEL_NAME: Record<string, string> = { fable: "Fable 5", opus: "Opus", sonnet: "Sonnet", haiku: "Haiku" };
const RUN_KIND: Record<string, AgentId> = { plan: "developer", execute: "developer", verify: "qa" };

/** Phrase lisible et agent concerné pour un événement du journal ; null si sans intérêt pour le fil. */
export function describeEvent(e: HubEvent): { agent: AgentId; text: string; tone?: "ok" | "warn" | "error" } | null {
  const p = e.payload;
  const n = (v: unknown) => (Array.isArray(v) ? v.length : 0);
  switch (e.type) {
    case "project.registered":
      return { agent: "you", text: "Projet ajouté au studio" };
    case "message.sent":
      return { agent: "you", text: "Vous avez écrit au directeur" };
    case "message.replied":
      return { agent: "director", text: "Le directeur vous a répondu" };
    case "extraction.completed":
      return n(p.created) ? { agent: "archivist", text: `L'archiviste a noté ${n(p.created)} idée(s)` } : null;
    case "extraction.failed":
      return { agent: "archivist", text: "L'archiviste n'a pas pu lire un passage", tone: "error" };
    case "synthesis.completed":
      return { agent: "director", text: "Le directeur a préparé des propositions", tone: "ok" };
    case "synthesis.failed":
      return { agent: "director", text: "Le regroupement a échoué", tone: "error" };
    case "proposal.submitted":
      return { agent: "director", text: `Nouvelle proposition : ${e.subject ?? ""}` };
    case "decision.validated":
      return p.delegated
        ? { agent: "director", text: `Le directeur a décidé ${e.subject ?? ""} (sans débat)`, tone: "ok" }
        : { agent: "you", text: `Vous avez validé ${e.subject ?? "une décision"}`, tone: "ok" };
    case "conception.started":
      return { agent: "concepteur", text: "Nouvelle conception" };
    case "conception.done":
      return { agent: "concepteur", text: "Conception terminée : chantiers prêts", tone: "ok" };
    case "project.autonomy_changed":
      return { agent: "you", text: `Autonomie du directeur : ${AUTONOMY_LABEL[String(p.to)] ?? String(p.to)}` };
    case "autopilot.failed":
      return { agent: "director", text: `Le directeur n'a pas pu décider ${e.subject ?? ""}`, tone: "error" };
    case "proposal.rejected":
      return { agent: "you", text: `Vous avez refusé ${e.subject ?? "une proposition"}` };
    case "proposal.returned":
      return { agent: "you", text: `Proposition renvoyée en discussion` };
    case "decision.abandoned":
      return { agent: "you", text: `Décision abandonnée : ${e.subject ?? ""}` };
    case "task.created":
      return { agent: "you", text: `Nouvelle tâche ${e.subject ?? ""}` };
    case "plan.submitted":
      return { agent: "developer", text: `Le développeur propose un plan (${e.subject ?? ""})`, tone: "warn" };
    case "plan.approved":
      return p.delegated
        ? { agent: "director", text: `Le directeur a validé un plan sans risque (${e.subject ?? ""})`, tone: "ok" }
        : { agent: "you", text: `Vous avez validé le plan de ${e.subject ?? ""}`, tone: "ok" };
    case "plan.rejected":
      return { agent: "you", text: `Vous avez refusé le plan de ${e.subject ?? ""}` };
    case "run.started": {
      const kind = String(p.kind ?? "");
      const text = { plan: "Le développeur étudie le code", execute: "Le développeur s'est mis au travail", verify: "Le testeur vérifie le travail" }[kind];
      return text ? { agent: RUN_KIND[kind] ?? "developer", text: `${text} (${e.subject ?? ""})` } : null;
    }
    case "run.done": {
      const kind = String(p.kind ?? "");
      const text = { plan: "Plan terminé", execute: "Travail terminé", verify: "Vérification terminée" }[kind] ?? "Terminé";
      return { agent: RUN_KIND[kind] ?? "developer", text: `${text} (${e.subject ?? ""})`, tone: "ok" };
    }
    case "run.failed":
      return { agent: RUN_KIND[String(p.kind)] ?? "developer", text: `Échec (${e.subject ?? ""})`, tone: "error" };
    case "run.cancelled":
      return { agent: RUN_KIND[String(p.kind)] ?? "developer", text: `Travail arrêté (${e.subject ?? ""})` };
    case "escalation.requested":
      return { agent: "guardian", text: "Le gardien vous demande une autorisation", tone: "warn" };
    case "policy.denied":
      return { agent: "guardian", text: "Le gardien a bloqué une action interdite", tone: "warn" };
    case "queue.paused": {
      const until = new Date(String(p.until)).toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" });
      const day = p.window === "seven_day" ? ` le ${new Date(String(p.until)).toLocaleDateString("fr-FR")}` : "";
      return { agent: "director", text: `Abonnement presque épuisé : ${e.subject ?? "le chantier suivant"} attend ${until}${day}`, tone: "warn" };
    }
    case "task.merged":
      return { agent: "you", text: `Fusionné dans votre jeu (${e.subject ?? ""})`, tone: "ok" };
    case "task.changes_requested":
      return { agent: "you", text: `Corrections demandées (${e.subject ?? ""})` };
    case "task.abandoned":
      return { agent: "you", text: `Tâche abandonnée (${e.subject ?? ""})` };
    case "task.cancelled":
      return { agent: "you", text: `Travail arrêté par vous (${e.subject ?? ""})` };
    case "model.changed": {
      // Le modèle des gros chantiers est celui du développeur (ADR-41).
      const big = e.subject === "developer_big";
      const agent = (big ? "developer" : (e.subject ?? "developer")) as AgentId;
      return { agent, text: `${AGENTS[agent]?.name ?? e.subject}${big ? " (gros chantiers)" : ""} passe de ${MODEL_NAME[String(p.from)] ?? String(p.from)} à ${MODEL_NAME[String(p.to)] ?? String(p.to)}` };
    }
    case "tool.installed":
      return { agent: "you", text: `Outil installé : ${e.subject ?? ""} ${String(p.version ?? "")}`.trim() };
    case "dissection.extracted":
      return { agent: "archivist", text: "Un jeu a été démonté : l'Archéologue l'étudie", tone: "ok" };
    case "dissection.failed":
      return { agent: "archivist", text: "Le démontage d'un jeu a échoué", tone: "error" };
    case "art.bible_updated":
      return { agent: "art_director", text: "Le Directeur artistique a mis la bible visuelle à jour" };
    case "art.render_added":
      return { agent: "you", text: `Vous avez déposé un rendu pour ${e.subject ?? "un visuel"}` };
    case "art.asset_validated":
      return { agent: p.by === "human" ? "you" : "art_director", text: `Visuel ${e.subject ?? ""} validé${p.by === "human" ? " par vous" : ""}`, tone: "ok" };
    case "art.asset_rejected":
      return { agent: p.by === "human" ? "you" : "art_director", text: `Visuel ${e.subject ?? ""} à retoucher`, tone: "warn" };
    case "art.integration_requested":
      return { agent: "you", text: `Intégration demandée pour ${e.subject ?? "un visuel"}` };
    case "art.asset_integrated":
      return { agent: "art_director", text: `Visuel ${e.subject ?? ""} intégré dans le jeu`, tone: "ok" };
    case "approval.recorded":
      return null;
    default:
      return null;
  }
}

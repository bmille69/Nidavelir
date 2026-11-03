import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Hub } from "../hub.ts";
import { artRoot, readManifest } from "../art/manifest.ts";
import type { TeamAgent } from "./team-service.ts";

/**
 * Ce que chaque agent sait quand un collègue le consulte (ADR-98). Lecture seule, bornée : un collègue consulté doit
 * répondre vite, avec l'essentiel de son domaine, pas relire tout le projet.
 */
export function teamBriefings(hub: Pick<Hub, "projects" | "vision" | "conceptions" | "tasks" | "sound" | "gameState" | "autopilot">): Record<TeamAgent, (project: string | null) => string> {
  const read = (file: string, max: number) => (existsSync(file) ? readFileSync(file, "utf8").slice(0, max) : "");
  const header = (project: string) => {
    const p = hub.projects.get(project);
    const brief = read(join(p.root, "studio", "BRIEF.md"), 3000);
    return [`<projet nom="${esc(p.name)}" />`, brief ? `<vision_du_jeu source="studio/BRIEF.md">\n${esc(brief)}\n</vision_du_jeu>` : ""].filter(Boolean).join("\n");
  };
  const decisions = (project: string, max = 40) =>
    hub.vision
      .list(project, { type: "decision", status: "validated" })
      .slice(-max)
      .map((d) => `- ${d.title} : ${(d.decision?.summary ?? d.statement).replace(/\s+/g, " ").slice(0, 200)}`)
      .join("\n");
  const tasks = (project: string, n: number) =>
    hub.tasks
      .list(project)
      .slice(-n)
      .map((t) => `- ${t.id} ${t.title} : ${t.status}`)
      .join("\n");
  const block = (tag: string, body: string) => (body.trim() ? `<${tag}>\n${esc(body.trim())}\n</${tag}>` : "");

  return {
    directeur: (project) => {
      if (!project) return "";
      return [
        header(project),
        block("decisions_validees", decisions(project)),
        block("etat_du_jeu", hub.gameState.get(project)?.text?.slice(0, 5000) ?? ""),
        block("chantiers_recents", tasks(project, 25)),
      ]
        .filter(Boolean)
        .join("\n\n");
    },
    concepteur: (project) => {
      const conceptions = hub.conceptions.list().filter((c) => c.project === project && c.data.dossier.trim());
      const dossier = conceptions[0]?.data.dossier ?? (project ? read(join(hub.projects.get(project).root, "studio", "conception.md"), 10_000) : "");
      return [project ? header(project) : "", block("dossier_de_conception", dossier.slice(0, 10_000)), project ? block("decisions_validees", decisions(project, 25)) : ""].filter(Boolean).join("\n\n");
    },
    da: (project) => {
      if (!project) return "";
      const root = hub.projects.get(project).root;
      const assets = readManifest(root).assets.slice(-50);
      return [
        header(project),
        block("bible_visuelle", read(join(artRoot(root), "bible.md"), 8000) || "(pas encore de bible visuelle)"),
        block("visuels", assets.map((a) => `- ${a.id} ${a.name} (${a.type}) : ${a.status}${a.usage ? ` — ${a.usage.slice(0, 120)}` : ""}`).join("\n")),
      ]
        .filter(Boolean)
        .join("\n\n");
    },
    son: (project) => {
      if (!project) return "";
      const sounds = hub.sound.sounds(project).slice(-40);
      return [header(project), block("sons", sounds.map((s) => `- ${s.id} ${s.name} (${s.kind}) : ${s.status} — ${s.usage.slice(0, 120)}`).join("\n") || "(aucun son pour l'instant)")].filter(Boolean).join("\n\n");
    },
    testeur: (project) => {
      if (!project) return "";
      const reports: string[] = [];
      for (const t of hub.tasks.list(project).slice(-30).reverse()) {
        const v = hub.tasks
          .runs(project, t.id)
          .filter((r) => r.kind === "verify" && r.result?.verification)
          .at(-1)?.result?.verification;
        if (!v) continue;
        reports.push(
          [
            `- ${t.id} ${t.title} : ${v.verdict}${v.playtest?.played ? " (joué)" : ""} — ${v.summary_simple.replace(/\s+/g, " ").slice(0, 300)}`,
            v.regressions.length ? `  régressions : ${v.regressions.join(" ; ").slice(0, 300)}` : "",
            v.playtest?.unverified.length ? `  pas vérifié en jeu : ${v.playtest.unverified.join(" ; ").slice(0, 200)}` : "",
          ]
            .filter(Boolean)
            .join("\n"),
        );
        if (reports.length >= 10) break;
      }
      return [header(project), block("derniers_rapports_de_verification", reports.join("\n") || "(aucune vérification pour l'instant)")].join("\n\n");
    },
  };
}

const esc = (s: string) => s.replace(/</g, "‹").replace(/>/g, "›");

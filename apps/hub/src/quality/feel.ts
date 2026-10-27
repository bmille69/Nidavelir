import { assertHumanSession, type HumanSession } from "../auth/human-session.ts";
import type { ConversationService } from "../conversation/conversation-service.ts";
import type { TaskService } from "../executor/task-service.ts";
import type { Journal } from "../journal/journal.ts";
import type { ProjectRegistry } from "../projects/project-registry.ts";
import { isGodot } from "../godot/toolchain.ts";
import type { Task } from "@studio/contracts";
import { existsSync } from "node:fs";
import { join } from "node:path";

/**
 * La passe « game feel » à la demande (ADR-88) : un chantier qui ne touche qu'à la sensation (ce que le joueur voit,
 * entend et ressent quand il agit), jamais aux règles. Les parties gardées et les simulations d'équilibrage du jeu en
 * sont la preuve : elles doivent donner exactement les mêmes résultats avant et après.
 */

export class FeelError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FeelError";
  }
}

export type FeelIntensity = "discret" | "marque" | "genereux";
const INTENSITY: Record<FeelIntensity, string> = {
  discret: "discrète : des retours nets mais sobres, rien qui fatigue l'œil sur une longue partie",
  marque: "marquée : chaque action importante se sent nettement",
  genereux: "généreuse, façon arcade : beaucoup de retours, mais l'action reste lisible",
};
export const DEFAULT_MOMENTS = "les actions principales du joueur (agir, toucher, détruire, perdre, gagner)";

export function feelGoal(input: { moments: string; intensity: FeelIntensity; godot: boolean; sims: boolean; replays: boolean }): string {
  const file = input.godot ? "res://scripts/feel.gd (autoload « Feel »)" : "src/feel.ts";
  const proof = [
    input.replays ? "le hub rejoue les parties gardées (studio/replays) : elles doivent passer à l'identique" : "",
    input.sims ? "lance les simulations d'équilibrage (tests/sims) avant et après : les chiffres doivent être identiques" : "",
  ].filter(Boolean);
  return [
    `Passe « game feel » sur : ${input.moments}. Intensité ${INTENSITY[input.intensity]}.`,
    "",
    "But : que ces moments se sentent, sans rien changer à ce qui s'y passe. Consulte d'abord la compétence game feel du studio si elle est disponible.",
    "",
    "1. Repère dans le code chaque moment visé et note ce qui le signale aujourd'hui (souvent rien).",
    "2. Pour chacun, choisis 2 à 4 retours parmi : arrêt sur image très court (hit-stop, 30 à 80 ms), tremblement de caméra à « trauma » qui décroît, flash ou teinte de l'objet touché, écrasement-étirement (squash and stretch), particules ou éclats, recul de l'arme ou de la caméra, petit zoom, courbe d'animation adoucie (tween avec easing), chiffres qui volent, point d'accroche pour un son (appel d'une fonction vide nommée, le directeur sonore viendra).",
    `3. Toutes les valeurs (durées, amplitudes, couleurs, nombres de particules) dans un seul fichier de réglages, ${file}, chaque effet avec son interrupteur et un réglage global d'intensité. Un réglage « mouvements réduits » coupe tremblements, zooms et flashs.`,
    "4. Interdit : changer une règle, une valeur de jeu (dégâts, vitesses, temps de recharge, vagues, économie), l'ordre ou le moment des événements, la physique, ou le hasard. Le hit-stop ne ralentit que l'affichage ou les effets, jamais la logique (pas de Engine.time_scale sur le jeu).",
    `5. Preuve que les règles n'ont pas bougé : les tests du jeu passent${proof.length ? ` ; ${proof.join(" ; ")}` : ""}. Le hub mesure aussi les performances : pas de chute d'images par seconde (particules en nombre borné, réutilisées).`,
    "6. Dans ton compte rendu, la liste : moment → retours ajoutés → nom des réglages, pour que le directeur créatif puisse doser.",
  ].join("\n");
}

export class FeelService {
  readonly #projects: ProjectRegistry;
  readonly #tasks: TaskService;
  readonly #conversations: ConversationService;
  readonly #journal: Journal;

  constructor(deps: { projects: ProjectRegistry; tasks: TaskService; conversations: ConversationService; journal: Journal }) {
    this.#projects = deps.projects;
    this.#tasks = deps.tasks;
    this.#conversations = deps.conversations;
    this.#journal = deps.journal;
  }

  /** « Passe game feel » : le chantier part tout de suite (ou attend son tour dans la file), suivi dans sa discussion. */
  async start(session: HumanSession, project: string, input: { moments?: string; intensity?: FeelIntensity }): Promise<{ task: Task; thread: string; after: string | null }> {
    assertHumanSession(session);
    const p = this.#projects.get(project);
    if (p.autonomy === "supervised") throw new FeelError("En « Je valide tout », demandez la passe au directeur dans une discussion : c'est vous qui lancez les chantiers");
    const moments = input.moments?.trim() || DEFAULT_MOMENTS;
    const intensity = input.intensity ?? "marque";
    const goal = feelGoal({ moments, intensity, godot: isGodot(p.root), sims: existsSync(join(p.root, "tests", "sims")), replays: existsSync(join(p.root, "studio", "replays")) });
    const short = moments.length > 70 ? `${moments.slice(0, 67)}…` : moments;
    const thread = this.#conversations.createThread(project, `Game feel : ${short}`);
    const task = this.#tasks.createFromConversation(project, { title: `Game feel : ${short}`, goal }, thread.id);
    const { after } = await this.#tasks.launch(project, task.id);
    this.#conversations.notify(
      project,
      thread.id,
      `✦ Passe « game feel » demandée par vous : ${moments} (intensité ${intensity === "marque" ? "marquée" : intensity === "genereux" ? "généreuse" : "discrète"}).\n${after ? `⏳ Chantier ${task.id} en attente : il partira tout seul après ${after.id}.` : `→ Chantier ${task.id} lancé.`} Les règles du jeu ne doivent pas bouger : tests, parties gardées et simulations le vérifient. Essayez ensuite, et dites ici ce qui est trop ou pas assez.`,
    );
    this.#journal.append({ project, actor: { kind: "human" }, type: "feel.requested", subject: task.id, payload: { moments, intensity } });
    return { task: this.#tasks.get(project, task.id), thread: thread.id, after: after?.id ?? null };
  }
}

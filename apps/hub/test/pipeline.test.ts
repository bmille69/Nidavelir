import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentPool } from "../src/executor/agent-pool.ts";
import { claudeScratch, PolicyEngine } from "../src/executor/policy-engine.ts";
import { directExecutionPrompt, verificationPrompt } from "../src/executor/prompts.ts";
import { createHub, type Hub } from "../src/hub.ts";
import { nextGlobalId } from "../src/util/ids.ts";
import { FakeExecutor, planOutput, REPORT, VERIFIED } from "./fake-executor.ts";
import { FakeOrchestrator } from "./fake-orchestrator.ts";
import { cleanupSandboxes, fakeClock, git, sandbox, type Sandbox } from "./helpers.ts";

/** Audit de la chaîne de production du 28/10 : une chaîne en béton, sans perte d'information d'une passe à l'autre. */
vi.setConfig({ testTimeout: 30_000 });
afterEach(() => cleanupSandboxes());

const P = "jeu";

async function settle(hub: Hub) {
  for (let k = 0; k < 6; k++) {
    await hub.conversations.idle();
    await hub.tasks.idle();
    await hub.autopilot?.idle();
    await hub.gameState.idle();
  }
}

async function workshop(maxAgents?: number) {
  const fake = new FakeOrchestrator();
  const exec = new FakeExecutor();
  const sb: Sandbox = sandbox();
  sb.hub.close();
  const hub = createHub({
    databasePath: join(sb.dir, "hub/.data/chaine.db"),
    registry: { forbiddenTrees: [join(sb.dir, "hub")], forbiddenExact: [sb.dir] },
    clock: fakeClock(),
    orchestrator: fake,
    executor: exec,
    dataDir: join(sb.dir, "hub/.data"),
    autopilot: { synthesisDelayMs: 0 },
    ...(maxAgents ? { maxAgents } : {}),
  });
  sb.hub = hub;
  const root = sb.makeGameRepo("games/jeu", { "README.md": "# Jeu\n", "src/main.ts": "export {};\n" });
  await hub.projects.register(sb.human(), { path: root, slug: P, name: "Jeu" });
  hub.projects.setAutonomy(sb.human(), P, "workshop");
  return { sb, hub, fake, exec, root };
}

describe("identifiants des passages (bug du 28/10)", () => {
  it("un numéro de passage est unique dans tout le hub, au-dessus de ceux déjà donnés par projet", () => {
    const sb = sandbox();
    const db = sb.hub.db;
    db.prepare("INSERT INTO counters (project, prefix, value) VALUES ('a', 'RUN', 5), ('b', 'RUN', 9)").run();
    expect(nextGlobalId(db, "RUN")).toBe("RUN-0010");
    expect(nextGlobalId(db, "RUN")).toBe("RUN-0011");
    // Un autre service continue de compter par projet : le compteur global reste au-dessus.
    db.prepare("UPDATE counters SET value = 30 WHERE project = 'a' AND prefix = 'RUN'").run();
    expect(nextGlobalId(db, "RUN")).toBe("RUN-0031");
  });
});

describe("réservoir d'agents", () => {
  it("au plus N passages à la fois ; une place rendue sert le suivant ; un passage arrêté pendant l'attente renonce", async () => {
    const pool = new AgentPool(1);
    const first = await pool.acquire();
    let second = false;
    const waiting = pool.acquire().then((r) => {
      second = true;
      return r;
    });
    const stop = new AbortController();
    const third = pool.acquire(stop.signal);
    expect(pool.waiting).toBe(2);
    stop.abort();
    await expect(third).rejects.toThrow(/arrêtée/);
    expect(second).toBe(false);
    first();
    first(); // rendre deux fois ne libère qu'une place
    const release = await waiting;
    expect(second).toBe(true);
    expect(pool.busy).toBe(1);
    release();
    expect(pool.busy).toBe(0);
  });

  it("le testeur passe même avec une seule place : la place du développeur est rendue avant sa vérification", async () => {
    const { hub, exec } = await workshop(1);
    expect(hub.tasks.agentPool().max).toBe(1);
    const task = hub.tasks.createFromConversation(P, { title: "Un", goal: "Créer src/un.ts" }, "fil");
    exec.scripts.execute.push(async (t) => {
      await t.write("src/un.ts", "export const un = 1;\n");
      return REPORT;
    });
    exec.scripts.verify.push(() => VERIFIED);
    await hub.tasks.launch(P, task.id);
    await settle(hub);
    expect(exec.requests.map((r) => r.kind)).toEqual(["execute", "verify"]);
    expect(hub.tasks.agentPool()).toMatchObject({ busy: 0, waiting: 0 });
    // Le passage a un numéro global : jamais le même qu'un passage d'un autre jeu.
    expect(new Set(exec.requests.map((r) => r.runId)).size).toBe(2);
  });
});

describe("gardien : moins d'actions perdues, rien de plus permis de dangereux", () => {
  const root = () => {
    const sb = sandbox();
    const dir = join(sb.dir, "copie");
    mkdirSync(join(dir, "src"), { recursive: true });
    writeFileSync(join(dir, "src", "a.ts"), "export {};\n");
    return dir;
  };

  it("un $ d'expression régulière entre guillemets passe ; une vraie variable reste refusée", () => {
    const p = new PolicyEngine({ mode: "verify", root: root() });
    expect(p.evaluate("Bash", { command: 'grep -v "^$" src/a.ts | tail -15' }).decision).toBe("allow");
    expect(p.evaluate("Bash", { command: 'grep -E "fin$|début" src/a.ts' }).decision).toBe("allow");
    for (const bad of ['echo "$HOME"', 'echo "exit=$?"', 'echo "x$(whoami)"', 'echo "${PATH}"', 'echo "$[1+1]"', "grep -v ^$ src/a.ts"]) {
      expect(p.evaluate("Bash", { command: bad }).decision, bad).toBe("deny");
    }
  });

  it("le « cat > /dev/null <<'EOF' » vide de Claude Code est ignoré ; un vrai heredoc reste refusé", () => {
    const p = new PolicyEngine({ mode: "verify", root: root() });
    expect(p.evaluate("Bash", { command: "cat > /dev/null <<'EOF'\nEOF\nsed -n 1,8p src/a.ts" }).decision).toBe("allow");
    expect(p.evaluate("Bash", { command: "cat >> /dev/null; tail -3 src/a.ts" }).decision).toBe("allow");
    expect(p.evaluate("Bash", { command: "cat > /dev/null <<'EOF'\nrm -rf src\nEOF\nls" }).decision).toBe("deny");
    expect(p.evaluate("Bash", { command: "cat > /tmp/p.txt <<'EOF'\nEOF\nls" }).decision).toBe("deny");
    expect(p.evaluate("Bash", { command: "cat > /dev/null <<'EOF'\nEOF\nnode -e 1" }).decision).toBe("deny");
  });

  it("les sorties longues que Claude Code range pour CETTE copie se lisent ; celles d'une autre copie, non", () => {
    const dir = root();
    const p = new PolicyEngine({ mode: "execute", root: dir });
    const mine = join(claudeScratch(dir), "session", "tasks", "b1.output");
    expect(p.evaluate("Read", { file_path: mine }).decision).toBe("allow");
    expect(p.evaluate("Bash", { command: `tail -40 ${mine.replace(/\\/g, "/")}` }).decision).toBe("allow");
    const other = join(claudeScratch(join(dir, "..", "autre")), "session", "tasks", "b1.output");
    expect(p.evaluate("Read", { file_path: other }).decision).toBe("deny");
    expect(p.evaluate("Write", { file_path: mine, content: "x" }).decision).toBe("deny");
    expect(claudeScratch("C:\\Games\\Ambition\\.data\\worktrees\\neon-saloon\\T-0034")).toMatch(/[\\/]claude[\\/]C--Games-Ambition--data-worktrees-neon-saloon-T-0034$/);
  });

  it("le même refus deux fois : l'agent est prié de changer d'approche", async () => {
    const { hub, exec } = await workshop();
    const task = hub.tasks.createFromConversation(P, { title: "Un", goal: "Créer src/un.ts" }, "fil");
    const reasons: string[] = [];
    exec.scripts.execute.push(async (t) => {
      for (const command of ["curl http://x", "curl http://y"]) reasons.push((await t.req.bridge.preTool("Bash", { command })).reason);
      await t.write("src/un.ts", "export {};\n");
      return REPORT;
    });
    exec.scripts.verify.push(() => VERIFIED);
    await hub.tasks.launch(P, task.id);
    await settle(hub);
    expect(reasons[0]).not.toMatch(/change d'approche/);
    expect(reasons[1]).toMatch(/2e refus pour la même raison .* change d'approche/);
  });
});

describe("prompts : rien ne se perd d'une passe à l'autre", () => {
  const task = { id: "T-0001", title: "Tirs", goal: "Des balles lumineuses : noyau blanc, sillage 0,12 s.", feedback: ["Le sillage ne se voit pas"], direct: true } as never;

  it("la correction rappelle au développeur sa passe précédente et marque le dernier retour", () => {
    const text = directExecutionPrompt(task, [], { files: ["src/balles.ts"], report: { ...REPORT, outcome: "completed", how_to_test: [], open_issues: ["sillage à régler"] } as never });
    expect(text).toMatch(/<ta_passe_precedente[\s\S]*- src\/balles\.ts[\s\S]*Fichier créé\.[\s\S]*sillage à régler[\s\S]*ne le refais pas de zéro/);
    expect(text).toMatch(/le dernier est celui à traiter maintenant/);
    expect(text).toMatch(/dis point par point ce que tu as corrigé/);
    expect(directExecutionPrompt(task, [])).not.toMatch(/ta_passe_precedente/);
  });

  it("le testeur découpe la consigne en exigences, revérifie d'abord ce qu'il avait relevé, et sait ce que le diff ne montre pas", () => {
    const plan = { acceptance_criteria: ["La consigne est réalisée"], commands: [] } as never;
    const previous = { ...VERIFIED, verdict: "fail", checks: [{ criterion: "Sillage visible", result: "fail", evidence: "aucun sillage à l'écran" }], regressions: ["le score ne monte plus"] } as never;
    const big = (name: string) => `diff --git a/${name} b/${name}\n${"+x\n".repeat(7_000)}`;
    const diff = big("src/a.ts") + big("src/b.ts") + big("src/c.ts");
    const text = verificationPrompt(task, plan, [], diff, REPORT, null, { previous, files: ["src/a.ts", "src/b.ts", "src/c.ts"], base: "abcdef1234567890" });
    expect(text).toMatch(/<exigences_de_la_consigne>[\s\S]*Découpe-la en exigences vérifiables/);
    expect(text).toMatch(/<verification_precedente>[\s\S]*Sillage visible : aucun sillage[\s\S]*Régression : le score ne monte plus[\s\S]*preuve nouvelle/);
    expect(text).toMatch(/<fichiers_modifies>\n- src\/a\.ts\n- src\/b\.ts\n- src\/c\.ts/);
    expect(text).toMatch(/fichier\(s\) non montrés ici faute de place, à lire avec « git diff abcdef123456 -- <fichier> » : src\/c\.ts/);
    // Un chantier avec plan validé n'a pas le bloc des exigences : ses critères sont ceux du plan.
    expect(verificationPrompt({ ...(task as object), direct: false } as never, plan, [], "", REPORT)).not.toMatch(/exigences_de_la_consigne/);
  });
});

describe("boucle de correction automatique", () => {
  it("chaque correction reçoit la passe précédente et tous les points ; la dernière prend le modèle des gros chantiers", async () => {
    const { hub, exec, fake } = await workshop();
    exec.scripts.plan.push(() => planOutput());
    const problems = Array.from({ length: 10 }, (_, k) => ({ criterion: `Exigence ${k + 1}`, result: "fail", evidence: `manque ${k + 1}` }));
    const failed = { ...VERIFIED, verdict: "fail", summary_simple: "Dix exigences manquent.", checks: problems };
    for (const v of ["v1", "v2", "v3"]) {
      exec.scripts.execute.push(async (t) => {
        await t.write("src/boss.ts", `export const v = '${v}';\n`);
        return { ...REPORT, open_issues: [`reste ${v}`] };
      });
      exec.scripts.verify.push(() => failed);
    }
    fake.replies.push("[[CHANTIER: Boss]]\nObjectif : un boss.\n[[/CHANTIER]]");
    await hub.conversations.send(P, hub.conversations.createThread(P, "x").id, "go");
    await settle(hub);

    const exe = exec.requests.filter((r) => r.kind === "execute");
    const ver = exec.requests.filter((r) => r.kind === "verify");
    expect(exe).toHaveLength(3);
    expect(exe.map((r) => Boolean(r.big))).toEqual([false, false, true]);
    expect(exe[0]!.prompt).not.toMatch(/ta_passe_precedente/);
    expect(exe[1]!.prompt).toMatch(/<ta_passe_precedente[\s\S]*- src\/boss\.ts[\s\S]*reste v1/);
    // Les dix points passent tous, sans coupe à huit.
    expect(exe[1]!.prompt).toMatch(/Exigence 10 : manque 10/);
    expect(ver[1]!.prompt).toMatch(/<verification_precedente>[\s\S]*Exigence 1 : manque 1/);
    expect(ver[0]!.prompt).not.toMatch(/verification_precedente/);
    const notes = hub.conversations.messages(P, hub.conversations.listThreads(P)[0]!.id).map((m) => m.text);
    expect(notes.some((n) => /dernière tentative automatique, avec le modèle des gros chantiers/.test(n))).toBe(true);
  });
});

describe("fusion sans usine à gaz", () => {
  it("ce que le hub a écrit dans studio/ sans l'enregistrer est commité avant la fusion, au lieu de vous demander un commit", async () => {
    const { hub, exec, root } = await workshop();
    mkdirSync(join(root, "studio", "art"), { recursive: true });
    writeFileSync(join(root, "studio", "art", "assets.json"), '{"assets":[]}\n');
    git(root, "add", "-A");
    git(root, "commit", "-q", "-m", "assets");
    const task = hub.tasks.createFromConversation(P, { title: "Un", goal: "Créer src/un.ts" }, "fil");
    exec.scripts.execute.push(async (t) => {
      await t.write("src/un.ts", "export {};\n");
      // Pendant ce temps, le DA du hub met à jour sa liste de visuels sans l'enregistrer (cas réel : fusions bloquées).
      writeFileSync(join(root, "studio", "art", "assets.json"), '{"assets":[{"id":"A-0001"}]}\n');
      return REPORT;
    });
    exec.scripts.verify.push(() => VERIFIED);
    await hub.tasks.launch(P, task.id);
    await settle(hub);
    expect(hub.tasks.get(P, task.id).status).toBe("merged");
    expect(git(root, "log", "--format=%s")).toMatch(/état du studio enregistré avant la fusion de T-0001/);
    expect(git(root, "show", "HEAD:studio/art/assets.json")).toMatch(/A-0001/);
    expect(git(root, "status", "--porcelain")).toBe("");
  });

  it("un fichier à vous modifié bloque toujours la fusion : il n'est jamais commité à votre place", async () => {
    const { hub, exec, root } = await workshop();
    const task = hub.tasks.createFromConversation(P, { title: "Un", goal: "Créer src/un.ts" }, "fil");
    exec.scripts.execute.push(async (t) => {
      await t.write("src/un.ts", "export {};\n");
      writeFileSync(join(root, "src", "main.ts"), "// travail en cours\n");
      writeFileSync(join(root, "README.md"), "# Jeu modifié\n");
      return REPORT;
    });
    exec.scripts.verify.push(() => VERIFIED);
    await hub.tasks.launch(P, task.id);
    await settle(hub);
    expect(hub.tasks.get(P, task.id).status).toBe("review");
    expect(git(root, "status", "--porcelain")).toMatch(/src\/main\.ts/);
  });
});

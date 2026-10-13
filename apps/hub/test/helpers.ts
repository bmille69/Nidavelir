import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Author, Source } from "@studio/contracts";
import { createHub, type Hub } from "../src/hub.ts";
import type { OrchestratorPort } from "../src/orchestrator/port.ts";

export const DIRECTOR: Author = { kind: "agent", role: "director", run: "RUN-0001" };
export const HUMAN: Author = { kind: "human" };
export const msg = (ref: string, quote: string): Source => ({ kind: "message", ref, quote });

/** Horloge déterministe : chaque appel avance d'une seconde. */
export function fakeClock(start = Date.UTC(2026, 9, 13, 12, 0, 0)) {
  let t = start;
  return { now: () => new Date((t += 1000)).toISOString() };
}

export function git(root: string, ...args: string[]): string {
  return execFileSync("git", ["-C", root, ...args], { encoding: "utf8" });
}

export type Sandbox = {
  dir: string;
  hub: Hub;
  /** Crée un dépôt Git de jeu avec un premier commit. */
  makeGameRepo(name: string, files?: Record<string, string>): string;
  /** Une vraie session humaine (comme après connexion du navigateur). */
  human(): ReturnType<Hub["sessions"]["verify"]>;
  cleanup(): void;
};

const live: Sandbox[] = [];

/** À passer à afterEach : nettoie tous les bacs à sable créés pendant le test. */
export function cleanupSandboxes(): void {
  for (const s of live.splice(0)) s.cleanup();
}

export function sandbox(orchestrator?: OrchestratorPort): Sandbox {
  const s = makeSandbox(orchestrator);
  live.push(s);
  return s;
}

function makeSandbox(orchestrator?: OrchestratorPort): Sandbox {
  const dir = mkdtempSync(join(tmpdir(), "studio-test-"));
  const hubRoot = join(dir, "hub");
  const dataDir = join(hubRoot, ".data");
  mkdirSync(dataDir, { recursive: true });
  const hub = createHub({
    databasePath: join(dataDir, "hub.db"),
    registry: { forbiddenTrees: [hubRoot], forbiddenExact: [dir] },
    clock: fakeClock(),
    orchestrator,
  });
  return {
    dir,
    hub,
    makeGameRepo(name, files = { "README.md": `# ${name}\n` }) {
      const root = join(dir, name);
      mkdirSync(root, { recursive: true });
      for (const [rel, content] of Object.entries(files)) {
        mkdirSync(join(root, rel, ".."), { recursive: true });
        writeFileSync(join(root, rel), content);
      }
      git(root, "init", "-q", "-b", "main");
      git(root, "config", "user.name", "Test");
      git(root, "config", "user.email", "test@example.invalid");
      git(root, "config", "core.autocrlf", "false");
      git(root, "add", "-A");
      git(root, "commit", "-q", "-m", "initial");
      return root;
    },
    human() {
      const token = hub.sessions.createLoginToken();
      const { sessionId, cookie, csrf } = hub.sessions.login(token);
      return hub.sessions.verify(sessionId, cookie, csrf);
    },
    cleanup() {
      hub.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { RealReverseTools, type GdreRun } from "../src/reverse/tools.ts";

/** Un dossier de données avec un GDRE « installé » (le fichier existe, on ne l'exécute jamais). */
function installed(): string {
  const data = mkdtempSync(join(tmpdir(), "nidavellir-gdre-"));
  const root = join(data, "tools", "gdre");
  mkdirSync(root, { recursive: true });
  const exe = join(root, "gdre_tools.exe");
  writeFileSync(exe, "");
  writeFileSync(join(root, "installed.json"), JSON.stringify({ version: "2.7.4", exe }));
  return data;
}

const input = (log: string[]) => ({
  tool: "gdre",
  pck: "C:/jeu/Jeu.pck",
  out: mkdtempSync(join(tmpdir(), "nidavellir-out-")),
  assembly: null,
  game: "C:/jeu",
  scriptsOnly: false,
  signal: new AbortController().signal,
  log: (l: string) => log.push(l),
});

describe("GDRE et les sommes de contrôle (ADR-126)", () => {
  it("reprend en ignorant le fichier abîmé au lieu de tout abandonner", async () => {
    const log: string[] = [];
    const calls: string[][] = [];
    // Ce que GDRE écrit vraiment quand une banque ne correspond plus à son empreinte (cas act1_a1.bank).
    const broken = [
      "Checksum failed for res://banks/desktop/act1_a1.bank",
      "At least one error was detected while verifying files in pack!",
      "MD5 checksum failed, not proceeding...",
      "Error: failed to extract PAK file, not exporting assets",
    ].join("\n");
    const run: GdreRun = async (_exe, args) => {
      calls.push(args);
      return calls.length === 1 ? { code: 1, tail: broken } : { code: 0, tail: "Recovery finished in 00m11s" };
    };
    await new RealReverseTools(installed(), { runGdre: run }).recover(input(log));

    expect(calls).toHaveLength(2);
    expect(calls[1]).toContain("--ignore-checksum-errors");
    expect(calls[0]).not.toContain("--ignore-checksum-errors");
    expect(log.join("\n")).toContain("act1_a1.bank");
    expect(log.join("\n")).toContain("somme de contrôle");
  });

  it("ne réessaie pas pour une autre panne, et dit ce qui s'est passé", async () => {
    const log: string[] = [];
    let calls = 0;
    const run: GdreRun = async () => {
      calls += 1;
      return { code: 2, tail: "Error: cannot open input file" };
    };
    await expect(new RealReverseTools(installed(), { runGdre: run }).recover(input(log))).rejects.toThrow(/s'est arrêté \(code 2\).*cannot open input file/s);
    expect(calls).toBe(1);
  });

  it("si même sans sommes de contrôle GDRE échoue, il demande de vérifier les fichiers du jeu", async () => {
    const log: string[] = [];
    const run: GdreRun = async () => ({ code: 1, tail: "Checksum failed for res://a.bank\nError: failed to extract PAK file" });
    await expect(new RealReverseTools(installed(), { runGdre: run }).recover(input(log))).rejects.toThrow(/Vérifiez les fichiers.*Steam|vérifier les fichiers/s);
  });
});

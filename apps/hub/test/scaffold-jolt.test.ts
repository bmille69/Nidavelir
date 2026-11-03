import { describe, expect, it } from "vitest";
import { claudeMdGodot, DEFAULT_SETUP, JOLT_SECTION, projectGodot } from "../src/godot/scaffold.ts";

// ADR-118 : un jeu 3D posé par le hub tourne sur Jolt ; un jeu 2D ne change pas.
describe("socle Godot : moteur physique", () => {
  it("un jeu 3D demande Jolt Physics", () => {
    const p = projectGodot("Essai", "4.6.2", { ...DEFAULT_SETUP, dimension: "3d" });
    expect(p).toContain(JOLT_SECTION);
    expect(p).toMatch(/\[physics\]\s+3d\/physics_engine="Jolt Physics"/);
    expect(claudeMdGodot("4.6.2", { ...DEFAULT_SETUP, dimension: "3d" })).toMatch(/Physique 3D : Jolt Physics/);
  });

  it("un jeu 2D n'a pas de section physique", () => {
    const p = projectGodot("Essai", "4.6.2", { ...DEFAULT_SETUP, dimension: "2d" });
    expect(p).not.toContain("[physics]");
    expect(claudeMdGodot("4.6.2", { ...DEFAULT_SETUP, dimension: "2d" })).not.toMatch(/Jolt/);
  });
});

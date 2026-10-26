import { describe, expect, it } from "vitest";
import { wasLoaded } from "../src/art/bilan.ts";

describe("bilan des visuels (ADR-71) : reconnaître une copie chargée par le jeu", () => {
  it("par son chemin dans le dépôt, ou servie sans son premier dossier (dossier public)", () => {
    expect(wasLoaded("assets/studio/heron.glb", ["/assets/studio/heron.glb?import"])).toBe(true);
    expect(wasLoaded("public/models/coffre.glb", ["/models/coffre.glb"])).toBe(true);
    expect(wasLoaded("public/drapeau.png", ["/jeu/drapeau.png"])).toBe(true);
    expect(wasLoaded("assets/studio/kit%20village.glb".replace("%20", " "), ["/assets/studio/kit%20village.glb"])).toBe(true);
    expect(wasLoaded("assets/studio/heron.glb", ["/assets/studio/heron2.glb", "/heron.png"])).toBe(false);
    expect(wasLoaded("public/drapeau.png", [])).toBe(false);
  });
});

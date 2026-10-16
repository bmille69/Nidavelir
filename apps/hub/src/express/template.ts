import { cpSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { renderConcept, type ExpressConcept } from "./prompts.ts";

/** Three.js installé avec le hub : copié dans les jeux 3D, aucun téléchargement pendant le chantier (ADR-44). */
export function threeDir(): string | null {
  try {
    // « three » se résout vers build/three.cjs : le dossier du paquet est deux niveaux au-dessus.
    return dirname(dirname(createRequire(import.meta.url).resolve("three")));
  } catch {
    return null;
  }
}

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

/** Le modèle de départ : une page qui se charge déjà sans erreur, prête à recevoir le jeu. */
export function writeTemplate(root: string, c: ExpressConcept, three = threeDir()): void {
  mkdirSync(join(root, "src"), { recursive: true });
  const importmap =
    c.dimension === "3d"
      ? `
    <script type="importmap">
      { "imports": { "three": "./lib/three/three.module.min.js", "three/addons/": "./lib/three/addons/" } }
    </script>`
      : "";
  writeFileSync(
    join(root, "index.html"),
    `<!doctype html>
<html lang="fr">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
    <title>${esc(c.title)}</title>
    <link rel="stylesheet" href="./style.css" />${importmap}
  </head>
  <body>
    <canvas id="game"></canvas>
    <script type="module" src="./src/main.js"></script>
  </body>
</html>
`,
  );
  writeFileSync(
    join(root, "style.css"),
    `html, body { margin: 0; height: 100%; overflow: hidden; background: #05060a; color: #fff; font-family: system-ui, sans-serif; }
canvas#game { display: block; width: 100vw; height: 100vh; touch-action: none; }
`,
  );
  writeFileSync(
    join(root, "src", "main.js"),
    `// Modèle de départ du Jeu express : remplacé par le jeu.
const canvas = document.getElementById("game");
const ctx = canvas.getContext("2d");
function draw() {
  canvas.width = innerWidth;
  canvas.height = innerHeight;
  ctx.fillStyle = "#05060a";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = "#7df0ff";
  ctx.font = "bold 32px system-ui";
  ctx.textAlign = "center";
  ctx.fillText(${JSON.stringify(c.title)} + " — en construction", canvas.width / 2, canvas.height / 2);
}
addEventListener("resize", draw);
draw();
`,
  );
  writeFileSync(join(root, "README.md"), `${renderConcept(c)}\n\nJeu express créé par Nidavellir : ouvrez-le depuis le studio (onglet « Jeu express »).\n`);
  writeFileSync(join(root, ".gitignore"), "node_modules/\n*.tmp\n");
  if (c.dimension === "3d" && three && existsSync(join(three, "build"))) {
    const lib = join(root, "lib", "three");
    mkdirSync(lib, { recursive: true });
    for (const f of ["three.module.min.js", "three.core.min.js"]) cpSync(join(three, "build", f), join(lib, f));
    for (const d of ["controls", "postprocessing", "shaders", "math"]) cpSync(join(three, "examples", "jsm", d), join(lib, "addons", d), { recursive: true });
    if (existsSync(join(three, "LICENSE"))) cpSync(join(three, "LICENSE"), join(lib, "LICENSE"));
  }
}

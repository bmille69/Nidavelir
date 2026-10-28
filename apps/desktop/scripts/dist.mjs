// Fabrique l'installateur Windows (apps/desktop/dist/Nidavellir-Setup-x.y.z.exe).
// L'application installée ne contient que la fenêtre : le hub reste dans ce dépôt, dont le chemin est gravé dans l'installateur
// (le dépôt d'où l'on lance cette commande ; STUDIO_HUB_ROOT pour en choisir un autre).
// Les fichiers sont d'abord copiés dans dist/.app : electron-builder ne touche jamais au package.json des sources.
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "electron-builder";

const desktop = resolve(fileURLToPath(new URL("..", import.meta.url)));
const root = resolve(process.env.STUDIO_HUB_ROOT ?? join(desktop, "..", ".."));
const pkg = JSON.parse(readFileSync(join(desktop, "package.json"), "utf8"));
const stage = join(desktop, "dist", ".app");

rmSync(stage, { recursive: true, force: true });
mkdirSync(stage, { recursive: true });
for (const f of ["main.js", "preload.cjs", "splash.html", "assets"]) cpSync(join(desktop, f), join(stage, f), { recursive: true });
const { name, productName, version, description, author, type, main } = pkg;
writeFileSync(join(stage, "package.json"), JSON.stringify({ name, productName, version, description, author, type, main, nidavellirRoot: root }, null, 2));

console.log(`Installateur Nidavellir : le hub sera lancé depuis ${root}`);
const files = await build({
  projectDir: desktop,
  win: ["nsis"],
  publish: "never",
  config: {
    ...pkg.build,
    directories: { app: stage, output: join(desktop, "dist"), buildResources: join(desktop, "assets") },
    win: { ...pkg.build.win, icon: join(desktop, "assets", "icon.png") },
  },
});
for (const f of files) if (f.endsWith(".exe")) console.log(`\nPrêt : ${f}`);

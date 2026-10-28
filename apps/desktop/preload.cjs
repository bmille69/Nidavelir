// Preload de l'application de bureau : annonce à l'interface qu'elle tourne dans la fenêtre Nidavellir
// (barre de titre maison, notifications Windows). Rien d'autre n'est exposé à la page.
const { contextBridge } = require("electron");

const arg = (name) => (process.argv.find((a) => a.startsWith(`--${name}=`)) ?? "").slice(name.length + 3);
contextBridge.exposeInMainWorld("nidavellir", { desktop: true, material: arg("nid-material") });

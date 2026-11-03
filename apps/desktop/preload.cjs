// Preload de l'application de bureau : annonce à l'interface qu'elle tourne dans la fenêtre Nidavellir
// (barre de titre maison, notifications Windows) et lui permet de demander un redémarrage. Rien d'autre n'est exposé.
const { contextBridge, ipcRenderer } = require("electron");

const arg = (name) => (process.argv.find((a) => a.startsWith(`--${name}=`)) ?? "").slice(name.length + 3);
contextBridge.exposeInMainWorld("nidavellir", {
  desktop: true,
  material: arg("nid-material"),
  // « Redémarrer et mettre à jour », aussi depuis la barre de titre et Ctrl K (pas seulement l'icône près de l'horloge).
  restart: () => ipcRenderer.send("nid:restart"),
});

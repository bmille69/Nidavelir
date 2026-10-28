import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.tsx";
import "./styles.css";
import "./studio/studio.css";
import "./studio/refonte.css";
import { registerServiceWorker } from "./studio/push.ts";
import { initMotion, installAutoGliders, installSpotlight } from "./studio/motion.tsx";

registerServiceWorker();
// Application de bureau : barre de titre maison, et matière Windows (Mica) sous le menu si la fenêtre en a une.
if (window.nidavellir?.desktop) {
  document.documentElement.classList.add("is-desktop");
  if (window.nidavellir.material) document.documentElement.classList.add("has-material");
}
// Refonte ADR-94 : le réglage des animations est posé avant le premier rendu, le halo de survol une fois pour toutes.
initMotion();
installSpotlight();
installAutoGliders();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

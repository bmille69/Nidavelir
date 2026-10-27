import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.tsx";
import "./styles.css";
import "./studio/studio.css";
import "./studio/refonte.css";
import { registerServiceWorker } from "./studio/push.ts";
import { initMotion, installAutoGliders, installSpotlight } from "./studio/motion.tsx";

registerServiceWorker();
// Refonte ADR-94 : le réglage des animations est posé avant le premier rendu, le halo de survol une fois pour toutes.
initMotion();
installSpotlight();
installAutoGliders();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

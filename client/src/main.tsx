import { resetSensitiveSurface } from "./ui/security/sensitiveSurface";
import { captureInitialLink } from "./transport/initialLink";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { applyDirection } from "./ui/tokens/direction";
import { applyAccent } from "./ui/tokens/accent";
import "./ui/styles/index.css";
import "./hosted/hosted.css";
import { hosted } from "./hosted/config";
import { App } from "./App";

captureInitialLink();
resetSensitiveSurface();
applyDirection();
if (hosted) {
  document.documentElement.dataset.hosted = '';
  let stored: string | null = null;
  try { stored = localStorage.getItem('hc-accent'); } catch { /* optional preference */ }
  if (!stored) applyAccent('amber'); else applyAccent();
} else applyAccent();
createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

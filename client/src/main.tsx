import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { DesktopUpdater } from "./ui/DesktopUpdater";
createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
    <DesktopUpdater />
  </StrictMode>,
);

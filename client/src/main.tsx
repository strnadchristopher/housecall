import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { applyDirection } from "./ui/tokens/direction";
import { applyAccent } from "./ui/tokens/accent";
import "./ui/styles/index.css";
import { App } from "./App";

applyDirection();
applyAccent();
createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

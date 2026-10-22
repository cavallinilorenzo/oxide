import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { highlighter } from "./highlighter";
import "./styles.css";

// Start the highlight worker now so common grammars are compiled before the
// first code block needs them.
highlighter();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

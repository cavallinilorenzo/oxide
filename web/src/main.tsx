import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { highlighter } from "./highlighter";
import { warmModelCatalogs } from "./modelCatalogCache";
import "./styles.css";
import "./workbench.css";

// Start the highlight worker now so common grammars are compiled before the
// first code block needs them.
highlighter();

// Detect Providers and load their model catalogs now, so the Model picker
// opens already populated.
void warmModelCatalogs();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

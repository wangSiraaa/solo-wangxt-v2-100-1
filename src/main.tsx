import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import UnitSuggestions from "./components/UnitSuggestions";
import "katex/dist/katex.min.css";
import "./styles.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
    <UnitSuggestions />
  </StrictMode>,
);

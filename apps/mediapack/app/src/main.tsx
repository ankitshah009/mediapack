import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { isFixtures } from "./api/client";
import "./index.css";

isFixtures(); // latch ?fixtures=1 for the tab before the first request
createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

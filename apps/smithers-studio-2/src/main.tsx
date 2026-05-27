import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "@wterm/react/css";
import App from "./App";
import "./app.css";

const rootElement = document.getElementById("root");

if (!rootElement) {
  throw new Error("Root element #root was not found.");
}

createRoot(rootElement).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

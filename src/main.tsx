import React, { lazy, Suspense } from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./App.css";

// The sub-windows are separate webviews (`?window=...`) that each load this same
// entry. They are lazy so their chunks (BuildModelWindow pulls in echarts) are only
// requested by the window that actually shows them — the main window's
// `index.html` must not modulepreload them. Imported from their own files, not the
// `components/windows` barrel, which would drag both back into one chunk.
const AddSensorWindow = lazy(() => import("./components/windows/AddSensorWindow"));
const BuildModelWindow = lazy(() => import("./components/windows/BuildModelWindow"));

const urlParams = new URLSearchParams(window.location.search);
const windowType = urlParams.get("window");

let RootComponent: React.ComponentType = App;

if (windowType === "add-sensor") {
  RootComponent = AddSensorWindow;
} else if (windowType === "build-model") {
  RootComponent = BuildModelWindow;
}

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    {/* Fallback = the app background, so a sub-window never flashes white while its chunk loads. */}
    <Suspense fallback={<div style={{ minHeight: "100vh", background: "var(--bg-primary)" }} />}>
      <RootComponent />
    </Suspense>
  </React.StrictMode>,
);

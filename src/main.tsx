import React, { lazy, Suspense } from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./App.css";
import "./motion.css";
import { installSlidingIndicators } from "./motion/slideIndicator";
import { installPresence } from "./motion/presence";
import { installPanelMotion } from "./motion/panelMotion";

// Sub-windows are lazy so only the window showing them requests their chunks; import from their own files, not the barrel, which would merge them.
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

installSlidingIndicators();
installPresence();
installPanelMotion(); // after presence: its observer runs second and replaces presence's copy of a closing panel

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    {/* Fallback = the app background, so a sub-window never flashes white while its chunk loads. */}
    <Suspense fallback={<div className="win-wait" style={{ minHeight: "100vh", background: "var(--bg-primary)" }} />}>
      <RootComponent />
    </Suspense>
  </React.StrictMode>,
);

import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { AddSensorWindow, PredictiveModelBuild, SaveAsWindow, BuildModelWindow, BuildModelOverviewWindow } from "./components/windows";
import "./App.css";

const urlParams = new URLSearchParams(window.location.search);
const windowType = urlParams.get("window");

let RootComponent = App;

if (windowType === "add-sensor") {
  RootComponent = AddSensorWindow;
} else if (windowType === "predictive-model") {
  RootComponent = PredictiveModelBuild;
} else if (windowType === "save-as") {
  RootComponent = SaveAsWindow;
} else if (windowType === "build-model") {
  RootComponent = BuildModelWindow;
} else if (windowType === "build-model-overview") {
  RootComponent = BuildModelOverviewWindow;
}

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <RootComponent />
  </React.StrictMode>,
);

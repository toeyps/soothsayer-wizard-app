import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import AddSensorWindow from "./components/AddSensorWindow";
import PredictiveModelBuild from "./components/PredictiveModelBuild";
import FailureGroupCreation from "./components/FailureGroupCreation";
import SaveAsWindow from "./components/SaveAsWindow";
import "./App.css";

const urlParams = new URLSearchParams(window.location.search);
const windowType = urlParams.get("window");

let RootComponent = App;

if (windowType === "add-sensor") {
  RootComponent = AddSensorWindow;
} else if (windowType === "predictive-model") {
  RootComponent = PredictiveModelBuild;
} else if (windowType === "failure-group") {
  RootComponent = FailureGroupCreation;
} else if (windowType === "save-as") {
  RootComponent = SaveAsWindow;
}

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <RootComponent />
  </React.StrictMode>,
);

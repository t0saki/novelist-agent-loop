import React from "react";
import ReactDOM from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import App from "./App";
import "./styles.css";

// 全局主题：跟随上次选择或系统偏好
const saved = localStorage.getItem("novelist_theme");
if (saved) document.documentElement.setAttribute("data-theme", saved);

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <BrowserRouter>
      <App />
    </BrowserRouter>
  </React.StrictMode>
);

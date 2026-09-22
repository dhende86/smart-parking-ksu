import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App        from "./App";
import DebugPage  from "./DebugPage";
import EditorPage from "./EditorPage";
import "./index.css";

const path = window.location.pathname;
const page = path === "/debug"  ? <DebugPage />
           : path === "/editor" ? <EditorPage />
           : <App />;

createRoot(document.getElementById("root")).render(
  <StrictMode>{page}</StrictMode>
);

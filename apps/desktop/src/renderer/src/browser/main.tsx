import ReactDOM from "react-dom/client";
import "../styles.css";
import "../shell.css";
import "./workspace.css";
import { BrowserWorkspace } from "./BrowserWorkspace";
ReactDOM.createRoot(document.getElementById("root")!).render(
  <BrowserWorkspace />,
);

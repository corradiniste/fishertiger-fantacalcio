import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./index.css";
import "./live-board.css";
import { LiveBoard } from "./live-board.jsx";

const params = new URLSearchParams(location.search);
const profileId = params.get("profile") || "";

createRoot(document.getElementById("root")).render(
  <StrictMode>
    <LiveBoard profileId={profileId} />
  </StrictMode>,
);

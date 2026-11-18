import React, { lazy, Suspense } from "react";
import { createRoot } from "react-dom/client";
import "./style.css";
const Holobox = lazy(() => import("./holobox/Holobox.jsx"));
const Console = lazy(() => import("./console/Console.jsx"));
const DeveloperMode = lazy(() => import("./developer/DeveloperMode.jsx"));

// Routes: /holobox = the output screen; /developer = the diagnostics workspace (embedded in the console's
// Diagnostics tab); everything else (/ and /console) = the team control console.
function Router() {
  const path = location.pathname.replace(/\/+$/, "");
  return (
    <Suspense fallback={null}>
      {path === "/holobox" ? <Holobox /> : path === "/developer" ? <DeveloperMode /> : <Console />}
    </Suspense>
  );
}
createRoot(document.getElementById("root")).render(<Router />);

import { createHashRouter } from "react-router";
import { Root } from "./components/Root";
import { LoginPage } from "./components/LoginPage";
import { Dashboard } from "./components/Dashboard";
import { StudentDashboard } from "./components/StudentDashboard";
import { AccessCodePage } from "./components/AccessCodePage";
import { SettingsPanel } from "./components/SettingsPanel";

export const router = createHashRouter([
  {
    path: "/",
    Component: Root,
    children: [
      { index: true, Component: LoginPage },
      { path: "access-code", Component: AccessCodePage },
      { path: "dashboard", Component: Dashboard },
      { path: "student-dashboard", Component: StudentDashboard },
      { path: "settings", Component: SettingsPanel },
    ],
  },
]);

import { useEffect, useState } from "react";
import { Outlet, useLocation, useNavigate } from "react-router";
import { useElectron } from "../ipc/useElectron";

const PROTECTED_PREFIXES = ["/dashboard", "/student-dashboard"];

function isProtectedPath(pathname: string): boolean {
  return PROTECTED_PREFIXES.some(
    (p) => pathname === p || pathname.startsWith(`${p}/`),
  );
}

export function Root() {
  const navigate = useNavigate();
  const location = useLocation();
  const api = useElectron();
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const session = await api.session.get();
      if (cancelled) return;

      const path = location.pathname;

      if (isProtectedPath(path)) {
        if (!session) {
          navigate("/", { replace: true });
          setReady(true);
          return;
        }
        if (session.persistent === false && session.expiresAt < Date.now()) {
          await api.session.clear();
          navigate("/", { replace: true });
          setReady(true);
          return;
        }
        if (path.startsWith("/dashboard") && session.role !== "admin") {
          navigate("/student-dashboard", { replace: true });
          setReady(true);
          return;
        }
        if (path.startsWith("/student-dashboard") && session.role !== "student") {
          navigate("/dashboard", { replace: true });
          setReady(true);
          return;
        }
        setReady(true);
        return;
      }

      if (path === "/" || path === "/access-code") {
        if (session && session.expiresAt > Date.now()) {
          navigate(session.role === "admin" ? "/dashboard" : "/student-dashboard", {
            replace: true,
          });
        }
      }
      setReady(true);
    })();

    return () => {
      cancelled = true;
    };
  }, [api, location.pathname, navigate]);

  useEffect(() => {
    const handler = (...args: unknown[]) => {
      const route = args[0];
      if (typeof route === "string") navigate(route);
    };
    api.on("navigate", handler);
    return () => api.off("navigate", handler);
  }, [api, navigate]);

  useEffect(() => {
    const handler = () => {
      void api.session.clear();
      navigate("/", { replace: true });
    };
    api.on("session:force-logout", handler);
    return () => api.off("session:force-logout", handler);
  }, [api, navigate]);

  if (!ready) {
    return (
      <div className="h-full w-full min-h-0" style={{ background: "#0d1320" }} />
    );
  }

  return (
    <div className="h-full min-h-0 flex flex-col">
      <Outlet />
    </div>
  );
}

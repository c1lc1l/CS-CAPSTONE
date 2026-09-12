import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { Bell, X } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "@/app/components/ui/popover";
import {
  INITIAL_NOTIFICATIONS,
  NotificationPanel,
  type Notification,
} from "@/app/components/NotificationPanel";
import { useElectron } from "../ipc/useElectron";

const GROTESK = "'Space Grotesk', sans-serif";
const MONO = "'Space Mono', monospace";

export type PushToastType = "info" | "warn" | "error" | "success";

export interface Toast {
  id: string;
  message: string;
  type: PushToastType;
}

const TOAST_STYLE: Record<
  PushToastType,
  { border: string; title: string; bg: string }
> = {
  info: { border: "#4a6fa5", title: "#7eb5f5", bg: "#111d30" },
  warn: { border: "#e8821a", title: "#e8821a", bg: "#111d30" },
  error: { border: "#e05c6a", title: "#e05c6a", bg: "#111d30" },
  success: { border: "#4ac77e", title: "#4ac77e", bg: "#111d30" },
};

interface NotificationContextValue {
  notifications: Notification[];
  pushToast: (msg: string, type?: PushToastType) => void;
  markRead: (id: string) => void;
  markAllRead: () => void;
  dismiss: (id: string) => void;
  clearAll: () => void;
  dismissToast: (id: string) => void;
  toasts: Toast[];
  unreadCount: number;
}

const NotificationContext = createContext<NotificationContextValue | null>(null);

export function useNotificationContext(): NotificationContextValue {
  const ctx = useContext(NotificationContext);
  if (!ctx) {
    throw new Error("useNotificationContext must be used within NotificationProvider");
  }
  return ctx;
}

function PushToastBubble({ toast: t, onDismiss }: { toast: Toast; onDismiss: () => void }) {
  const st = TOAST_STYLE[t.type];
  const [isClosing, setIsClosing] = useState(false);

  const startDismiss = useCallback(() => {
    setIsClosing(true);
    setTimeout(onDismiss, 240);
  }, [onDismiss]);

  useEffect(() => {
    const timer = setTimeout(startDismiss, 5000);
    return () => clearTimeout(timer);
  }, [startDismiss]);

  return (
    <div
      className="flex items-start gap-3 p-4 rounded-lg border shadow-xl transition-all duration-200"
      style={{
        background: st.bg,
        borderColor: st.border + "55",
        minWidth: "280px",
        maxWidth: "340px",
        fontFamily: GROTESK,
        opacity: isClosing ? 0 : 1,
        transform: isClosing ? "translateX(6px)" : "translateX(0)",
      }}
    >
      <div className="flex-1 min-w-0">
        <p className="text-[#c5d5ea]" style={{ fontSize: "12px" }}>
          {t.message}
        </p>
        <p className="text-[#4a6080] mt-0.5 uppercase" style={{ fontSize: "9px", fontFamily: MONO }}>
          {t.type}
        </p>
      </div>
      <button
        type="button"
        onClick={startDismiss}
        className="text-[#4a6080] hover:text-[#c5d5ea] transition-colors shrink-0"
        aria-label="Dismiss"
      >
        <X size={12} />
      </button>
    </div>
  );
}

function ToastStack({
  toasts,
  onDismiss,
}: {
  toasts: Toast[];
  onDismiss: (id: string) => void;
}) {
  if (toasts.length === 0) return null;
  return (
    <div
      className="fixed bottom-16 right-5 z-[var(--z-toast)] flex flex-col gap-2 pointer-events-none"
      style={{ animation: "slideInRight 0.3s ease" }}
    >
      <div className="pointer-events-auto flex flex-col gap-2">
        {toasts.map((t) => (
          <PushToastBubble key={t.id} toast={t} onDismiss={() => onDismiss(t.id)} />
        ))}
      </div>
    </div>
  );
}

/** Header bell + Radix popover panel (use inside NotificationProvider). */
export function NotificationsMenu() {
  const [open, setOpen] = useState(false);
  const { notifications, markRead, markAllRead, dismiss, clearAll, unreadCount } =
    useNotificationContext();

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          className="relative w-8 h-8 flex items-center justify-center text-[#4a6080] hover:text-[#7eb5f5] transition-colors"
          title="Notifications"
        >
          <Bell size={16} />
          {unreadCount > 0 && (
            <span
              className="absolute -top-1 -right-1 flex items-center justify-center rounded-full text-white"
              style={{
                background: "#e05c6a",
                fontSize: "8px",
                fontFamily: MONO,
                minWidth: "15px",
                height: "15px",
                padding: "0 3px",
                lineHeight: 1,
              }}
            >
              {unreadCount > 9 ? "9+" : unreadCount}
            </span>
          )}
        </button>
      </PopoverTrigger>
      <PopoverContent
        align="end"
        sideOffset={8}
        className="w-auto max-w-[calc(100vw-1rem)] border-0 bg-transparent p-0 shadow-none"
      >
        <NotificationPanel
          notifications={notifications}
          onClose={() => setOpen(false)}
          onMarkRead={markRead}
          onMarkAllRead={markAllRead}
          onDismiss={dismiss}
          onClearAll={clearAll}
        />
      </PopoverContent>
    </Popover>
  );
}

export function NotificationProvider({ children }: { children: ReactNode }) {
  const api = useElectron();
  const [notifications, setNotifications] = useState<Notification[]>(INITIAL_NOTIFICATIONS);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [notificationsEnabled, setNotificationsEnabled] = useState(true);
  const toastSeq = useRef(0);

  useEffect(() => {
    void api.settings.get().then((settings) => setNotificationsEnabled(settings.notifications !== false));
    const onSettingsChanged = (event: Event) => {
      const next = (event as CustomEvent<{ notifications?: boolean }>).detail;
      if (typeof next?.notifications === "boolean") setNotificationsEnabled(next.notifications);
    };
    window.addEventListener("runa-settings-changed", onSettingsChanged);
    return () => window.removeEventListener("runa-settings-changed", onSettingsChanged);
  }, [api]);

  const unreadCount = useMemo(
    () => notifications.filter((n) => !n.read).length,
    [notifications],
  );

  const pushToast = useCallback((msg: string, type: PushToastType = "info") => {
    if (!notificationsEnabled) return;
    const id = `t-${toastSeq.current++}`;
    setToasts((prev) => [{ id, message: msg, type }, ...prev].slice(0, 5));
  }, [notificationsEnabled]);

  const dismissToast = useCallback((id: string) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const markRead = useCallback((id: string) => {
    setNotifications((prev) => prev.map((n) => (n.id === id ? { ...n, read: true } : n)));
  }, []);

  const markAllRead = useCallback(() => {
    setNotifications((prev) => prev.map((n) => ({ ...n, read: true })));
  }, []);

  const dismiss = useCallback((id: string) => {
    setNotifications((prev) => prev.filter((n) => n.id !== id));
  }, []);

  const clearAll = useCallback(() => {
    setNotifications([]);
  }, []);

  const value = useMemo<NotificationContextValue>(
    () => ({
      notifications,
      pushToast,
      markRead,
      markAllRead,
      dismiss,
      clearAll,
      dismissToast,
      toasts,
      unreadCount,
    }),
    [
      notifications,
      pushToast,
      markRead,
      markAllRead,
      dismiss,
      clearAll,
      dismissToast,
      toasts,
      unreadCount,
    ],
  );

  return (
    <NotificationContext.Provider value={value}>
      {children}
      <ToastStack toasts={toasts} onDismiss={dismissToast} />
    </NotificationContext.Provider>
  );
}

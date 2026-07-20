import { useEffect, useRef, useState } from "react";
import type { FleetSession, SessionStatus } from "../types";

const BASE_TITLE = "Mission Control";

export type NotifPermission = "granted" | "denied" | "default" | "unsupported";

export function useNotifications(fleet: FleetSession[]): {
  notifPermission: NotifPermission;
} {
  const [notifPermission, setNotifPermission] = useState<NotifPermission>(() => {
    if (typeof Notification === "undefined") return "unsupported";
    return Notification.permission as NotifPermission;
  });

  // Badge in document title.
  useEffect(() => {
    const waitingCount = fleet.filter((s) => s.status === "waiting").length;
    document.title = waitingCount > 0 ? `[${waitingCount} WAITING] ${BASE_TITLE}` : BASE_TITLE;
    return () => {
      document.title = BASE_TITLE;
    };
  }, [fleet]);

  // Detect transitions to "waiting" and send browser notifications.
  const prevStatuses = useRef<Map<string, SessionStatus>>(new Map());
  const pendingPermission = useRef(false);
  const isInitialRender = useRef(true);

  useEffect(() => {
    const prev = prevStatuses.current;

    if (isInitialRender.current) {
      isInitialRender.current = false;
      for (const s of fleet) prev.set(s.sessionId, s.status);
      return;
    }

    const newlyWaiting = fleet.filter(
      (s) => s.status === "waiting" && prev.get(s.sessionId) !== "waiting",
    );

    for (const s of fleet) prev.set(s.sessionId, s.status);

    if (newlyWaiting.length === 0 || typeof Notification === "undefined") return;

    const emit = (session: FleetSession) => {
      const body = session.waitingFor
        ? `${session.sessionId.slice(0, 8)} — ${session.waitingFor}`
        : `Session ${session.sessionId.slice(0, 8)} attend votre input`;
      const notif = new Notification("Session en attente", { body, tag: session.sessionId });
      notif.onclick = () => { window.focus(); notif.close(); };
      setTimeout(() => notif.close(), 8_000);
    };

    if (Notification.permission === "granted") {
      newlyWaiting.forEach(emit);
      return;
    }

    if (Notification.permission === "denied") return;

    // "default" — request once, then emit all pending.
    if (!pendingPermission.current) {
      pendingPermission.current = true;
      void Notification.requestPermission().then((result) => {
        pendingPermission.current = false;
        setNotifPermission(result as NotifPermission);
        if (result === "granted") newlyWaiting.forEach(emit);
      });
    }
  }, [fleet]);

  return { notifPermission };
}

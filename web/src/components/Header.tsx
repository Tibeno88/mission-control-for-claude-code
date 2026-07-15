import { useEffect, useState } from "react";
import { fmtClock } from "../lib/format";
import type { FleetSession } from "../types";

function useClock(): Date {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(timer);
  }, []);
  return now;
}

interface HeaderProps {
  connected: boolean;
  fleet: FleetSession[];
}

export function Header({ connected, fleet }: HeaderProps) {
  const now = useClock();
  const busy = fleet.filter((s) => s.status === "busy").length;
  const waiting = fleet.filter((s) => s.status === "waiting").length;
  const idle = fleet.filter((s) => s.status === "idle").length;
  const date = now
    .toLocaleDateString("fr-FR", {
      weekday: "short",
      day: "2-digit",
      month: "short",
    })
    .toUpperCase();

  return (
    <header className="header">
      <div className="header-brand">
        <svg viewBox="0 0 40 40" className="reactor" aria-hidden="true">
          <circle
            cx="20"
            cy="20"
            r="17"
            fill="none"
            stroke="currentColor"
            strokeOpacity="0.25"
            strokeWidth="1"
          />
          <circle
            cx="20"
            cy="20"
            r="11"
            fill="none"
            stroke="currentColor"
            strokeOpacity="0.5"
            strokeWidth="1"
            strokeDasharray="4 3"
          />
          <path
            className="reactor-arc"
            d="M20 3 A17 17 0 0 1 37 20"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
          />
          <circle
            className="reactor-core"
            cx="20"
            cy="20"
            r="4"
            fill="currentColor"
          />
        </svg>
        <div>
          <h1>
            CLAUDE<span className="header-sep"> // </span>MISSION CONTROL
          </h1>
          <p className="header-sub">LOCAL SESSION SUPERVISION GRID</p>
        </div>
      </div>
      <div className="header-status">
        <div className="counts mono">
          <span className="count busy">{busy} RUN</span>
          <span className={`count waiting ${waiting > 0 ? "alert" : ""}`}>
            {waiting} WAIT
          </span>
          <span className="count idle">{idle} IDLE</span>
        </div>
        <div className="clock mono">
          <span className="clock-time">{fmtClock(now)}</span>
          <span className="clock-date">{date}</span>
        </div>
        <div className={`uplink mono ${connected ? "on" : "off"}`}>
          <span className="led" aria-hidden="true" />
          {connected ? "UPLINK ONLINE" : "UPLINK LOST"}
        </div>
      </div>
    </header>
  );
}

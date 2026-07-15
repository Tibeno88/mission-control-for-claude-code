import type { FleetSession } from "../types";

export function fmtTokens(count: number): string {
  if (count >= 1e9) return `${(count / 1e9).toFixed(2)}B`;
  if (count >= 1e6) return `${(count / 1e6).toFixed(2)}M`;
  if (count >= 1e3) return `${(count / 1e3).toFixed(1)}k`;
  return String(count);
}

export function fmtUSD(amount: number): string {
  if (amount > 0 && amount < 0.01) return "<$0.01";
  return `$${amount.toFixed(2)}`;
}

export function timeAgo(sinceMs: number): string {
  const seconds = Math.max(0, Math.floor((Date.now() - sinceMs) / 1000));
  if (seconds < 10) return "now";
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

export function tsToMs(ts: string | undefined): number {
  if (!ts) return 0;
  const ms = Date.parse(ts);
  return Number.isNaN(ms) ? 0 : ms;
}

export function shortId(id: string): string {
  return id.slice(0, 8);
}

export function modelShort(model: string): string {
  return model.replace(/^claude-/, "").replace(/-\d{8}$/, "");
}

export function projectName(
  session: Pick<FleetSession, "cwd" | "projectSlug">,
): string {
  if (session.cwd) {
    const base = session.cwd.split("/").filter(Boolean).pop();
    if (base) return base;
  }
  const slug = session.projectSlug ?? "";
  return slug.split("-").filter(Boolean).pop() ?? "unknown";
}

export function fmtClock(date: Date): string {
  const pad = (n: number): string => String(n).padStart(2, "0");
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

export function fmtEventTime(ts: string): string {
  const ms = tsToMs(ts);
  return ms ? fmtClock(new Date(ms)) : "--:--:--";
}

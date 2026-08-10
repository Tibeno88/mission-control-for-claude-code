import os from "node:os";
import path from "node:path";

export interface Config {
  port: number;
  claudeDir: string;
  projectsDir: string;
  sessionsDir: string;
  scanDays: number;
  registryPollMs: number;
  broadcastDebounceMs: number;
  dataDir: string;
  dbPath: string;
  backupDir: string;
}

function intFromEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (Number.isNaN(parsed) || parsed <= 0) {
    throw new Error(
      `Invalid value for ${name}: "${raw}" (positive integer expected)`,
    );
  }
  return parsed;
}

export function loadConfig(): Config {
  const claudeDir =
    process.env.CMC_CLAUDE_DIR ?? path.join(os.homedir(), ".claude");
  const dataDir =
    process.env.CMC_DATA_DIR ??
    path.join(os.homedir(), ".claude-mission-control");
  return {
    port: intFromEnv("CMC_PORT", 4517),
    claudeDir,
    projectsDir: path.join(claudeDir, "projects"),
    sessionsDir: path.join(claudeDir, "sessions"),
    scanDays: intFromEnv("CMC_SCAN_DAYS", 7),
    registryPollMs: 3000,
    broadcastDebounceMs: 500,
    dataDir,
    dbPath: path.join(dataDir, "cmc.db"),
    backupDir: path.join(dataDir, "archives"),
  };
}

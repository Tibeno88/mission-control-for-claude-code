import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { LiveRegistry } from "../src/sessions.js";

const SESSION_ID = "11111111-2222-3333-4444-555555555555";
const POLL_MS = 60_000;

describe("LiveRegistry", () => {
  let root: string;
  let registry: LiveRegistry;

  beforeEach(async () => {
    root = await fsp.mkdtemp(path.join(os.tmpdir(), "cmc-registry-"));
    registry = new LiveRegistry(root, POLL_MS);
  });

  afterEach(async () => {
    await registry.stop();
    await fsp.rm(root, { recursive: true, force: true });
  });

  /** `pid` must be a live process: readSessionFile drops entries failing pidAlive. */
  async function writeRegistryFile(
    extra: Record<string, unknown>,
  ): Promise<void> {
    await fsp.writeFile(
      path.join(root, `${process.pid}.json`),
      JSON.stringify({
        pid: process.pid,
        sessionId: SESSION_ID,
        cwd: "/home/user/projects/demo",
        kind: "bg",
        status: "busy",
        startedAt: 1_700_000_000_000,
        updatedAt: 1_700_000_000_000,
        ...extra,
      }),
    );
  }

  test("exposes the session title and its origin", async () => {
    await writeRegistryFile({
      name: "[demo] Titre synthetique",
      nameSource: "derived",
    });

    await registry.refresh();

    const sessions = registry.list();
    expect(sessions).toHaveLength(1);
    expect(sessions[0]?.name).toBe("[demo] Titre synthetique");
    expect(sessions[0]?.nameSource).toBe("derived");
  });

  test("leaves nameSource undefined for an explicitly chosen title", async () => {
    await writeRegistryFile({ name: "[demo] Titre choisi" });

    await registry.refresh();

    expect(registry.list()[0]?.name).toBe("[demo] Titre choisi");
    expect(registry.list()[0]?.nameSource).toBeUndefined();
  });

  test("ignores non-string name and nameSource values", async () => {
    await writeRegistryFile({ name: 42, nameSource: { auto: true } });

    await registry.refresh();

    const session = registry.list()[0];
    expect(session?.sessionId).toBe(SESSION_ID);
    expect(session?.name).toBeUndefined();
    expect(session?.nameSource).toBeUndefined();
  });
});

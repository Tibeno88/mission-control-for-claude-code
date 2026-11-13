import type { Context, Next } from "hono";

const LOCAL_HOSTNAMES = new Set(["127.0.0.1", "localhost"]);

function hostnameOf(hostHeader: string | undefined): string | null {
  if (!hostHeader) return null;
  try {
    return new URL(`http://${hostHeader}`).hostname;
  } catch {
    return null;
  }
}

/**
 * Anti DNS-rebinding / cross-site check: local Host, and an Origin (when sent)
 * that is local and same-origin with Host. Returns the refusal reason, or null.
 */
export function localRequestError(
  host: string | undefined,
  origin: string | undefined,
): "forbidden host" | "forbidden origin" | null {
  if (!LOCAL_HOSTNAMES.has(hostnameOf(host) ?? "")) return "forbidden host";
  if (origin === undefined) return null;
  let o: URL | undefined;
  try {
    o = new URL(origin);
  } catch {
    o = undefined;
  }
  if (!o || !LOCAL_HOSTNAMES.has(o.hostname) || o.host !== host)
    return "forbidden origin";
  return null;
}

/** Every method: GET routes expose transcripts too, so reads need the check as well. */
export async function localRequestGuard(c: Context, next: Next) {
  const error = localRequestError(c.req.header("host"), c.req.header("origin"));
  if (error) return c.json({ error }, 403);
  return next();
}

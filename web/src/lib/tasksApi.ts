/** Calls a task mutation route; resolves to an error message, or null on success. */
export async function taskRequest(
  method: "POST" | "PATCH",
  path: string,
  body: unknown = {},
): Promise<string | null> {
  try {
    const res = await fetch(`/api/tasks${path}`, {
      method,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (res.ok) return null;
    const data = (await res.json().catch(() => null)) as {
      error?: string;
    } | null;
    return data?.error ?? `HTTP ${res.status}`;
  } catch {
    return "serveur injoignable";
  }
}

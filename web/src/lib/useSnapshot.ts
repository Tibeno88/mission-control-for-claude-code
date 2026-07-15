import { useEffect, useState } from "react";
import type { Snapshot } from "../types";

const MAX_RETRY_MS = 15_000;

export function useSnapshot(): { snap: Snapshot | null; connected: boolean } {
  const [snap, setSnap] = useState<Snapshot | null>(null);
  const [connected, setConnected] = useState(false);

  useEffect(() => {
    let socket: WebSocket | null = null;
    let disposed = false;
    let retryMs = 1000;

    const wsUrl = `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws`;

    const connect = (): void => {
      if (disposed) return;
      socket = new WebSocket(wsUrl);
      socket.onopen = () => {
        setConnected(true);
        retryMs = 1000;
      };
      socket.onmessage = (event) => {
        try {
          const message = JSON.parse(event.data as string) as Snapshot;
          if (message.type === "snapshot") setSnap(message);
        } catch {
          // ignore malformed frames
        }
      };
      socket.onclose = () => {
        setConnected(false);
        if (!disposed) {
          setTimeout(connect, retryMs);
          retryMs = Math.min(retryMs * 2, MAX_RETRY_MS);
        }
      };
      socket.onerror = () => socket?.close();
    };

    connect();

    // Initial paint without waiting for the socket handshake.
    fetch("/api/snapshot")
      .then((response) => (response.ok ? response.json() : null))
      .then((data: Snapshot | null) => {
        if (data && !disposed) setSnap((current) => current ?? data);
      })
      .catch(() => undefined);

    return () => {
      disposed = true;
      socket?.close();
    };
  }, []);

  return { snap, connected };
}

import { logger } from "../lib/logger";

/**
 * Auto-healing WebSocket manager with exponential-backoff reconnection.
 * Wraps the Node 22+ native WebSocket global.
 */
export class WsManager {
  private ws: WebSocket | null = null;
  private reconnectDelay = 1_000;
  private readonly maxDelay = 30_000;
  private destroyed = false;
  private pingTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly url: string,
    private readonly onMessage: (data: string) => void,
    private readonly onConnected?: () => void
  ) {}

  connect(): void {
    if (this.destroyed) return;
    logger.info({ url: this.url }, "WS connecting");

    try {
      this.ws = new WebSocket(this.url);
    } catch (err) {
      logger.error({ err, url: this.url }, "WS constructor failed");
      this.scheduleReconnect();
      return;
    }

    this.ws.addEventListener("open", () => {
      logger.info({ url: this.url }, "WS connected");
      this.reconnectDelay = 1_000;
      this.startPing();
      this.onConnected?.();
    });

    this.ws.addEventListener("message", (event) => {
      this.onMessage(String(event.data));
    });

    this.ws.addEventListener("error", (event) => {
      logger.error({ url: this.url, event }, "WS error");
    });

    this.ws.addEventListener("close", () => {
      if (this.destroyed) return;
      this.stopPing();
      logger.warn(
        { url: this.url, nextDelay: this.reconnectDelay },
        "WS closed — reconnecting"
      );
      this.scheduleReconnect();
    });
  }

  send(payload: string): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(payload);
    }
  }

  destroy(): void {
    this.destroyed = true;
    this.stopPing();
    this.ws?.close();
  }

  private scheduleReconnect(): void {
    const delay = this.reconnectDelay;
    this.reconnectDelay = Math.min(this.reconnectDelay * 2, this.maxDelay);
    setTimeout(() => this.connect(), delay);
  }

  private startPing(): void {
    this.pingTimer = setInterval(() => {
      try {
        this.ws?.send(JSON.stringify({ type: "ping" }));
      } catch { /* ignore */ }
    }, 30_000);
  }

  private stopPing(): void {
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
  }
}

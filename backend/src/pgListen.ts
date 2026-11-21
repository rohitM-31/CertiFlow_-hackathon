import pg from "pg";
import { config } from "./config.js";
import { log } from "./logger.js";

/**
 * Listen on a Postgres NOTIFY channel using a dedicated connection that reconnects
 * automatically (e.g. after a database restart). Notifications sent while disconnected
 * are missed, which is fine for how we use them: workers also poll every second, and
 * browsers refetch on reconnect.
 *
 * `channel` must be one of our own constant names (it is not escaped).
 */
export function listen(channel: string, onMessage: (payload: string) => void): () => Promise<void> {
  let client: pg.Client | undefined;
  let stopped = false;

  const retryLater = () => {
    if (!stopped) setTimeout(() => void connect(), 2_000);
  };

  const connect = async () => {
    if (stopped) return;
    const c = new pg.Client({ connectionString: config.databaseUrl });
    c.on("notification", (msg) => {
      if (msg.channel === channel) onMessage(msg.payload ?? "");
    });
    c.on("error", (err) => {
      log.warn("listener connection lost, reconnecting", { channel, error: err.message });
      if (client === c) client = undefined;
      c.end().catch(() => {});
      retryLater();
    });
    try {
      await c.connect();
      await c.query(`LISTEN ${channel}`);
      client = c;
    } catch (err) {
      log.warn("listener could not connect, retrying", { channel, error: (err as Error).message });
      c.end().catch(() => {});
      retryLater();
    }
  };

  void connect();
  return async () => {
    stopped = true;
    await client?.end().catch(() => {});
  };
}

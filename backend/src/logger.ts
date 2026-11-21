// Minimal structured logger: one JSON object per line, easy to search.
// Include batchId / certificateId / jobId / requestId whenever known, so one batch
// can be traced end to end across the API and the worker.

type Fields = Record<string, unknown>;

function write(level: string, msg: string, fields: Fields = {}) {
  if (process.env["NODE_ENV"] === "test" && level !== "error") return;
  console.log(JSON.stringify({ time: new Date().toISOString(), level, msg, ...fields }));
}

export const log = {
  info: (msg: string, fields?: Fields) => write("info", msg, fields),
  warn: (msg: string, fields?: Fields) => write("warn", msg, fields),
  error: (msg: string, fields?: Fields) => write("error", msg, fields),
};

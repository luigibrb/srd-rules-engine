/** Serve a fetch handler with Node's built-in `http` module (no framework needed). */

import { createServer, type IncomingMessage, type Server } from "node:http";
import type { FetchHandler } from "./index";

/** Largest request body accepted, in bytes. */
const MAX_BODY = 1_000_000;

export function serveNode(
  handler: FetchHandler,
  { port = 8000, host = "127.0.0.1" }: { port?: number; host?: string } = {},
): Promise<Server> {
  const server = createServer(async (req, res) => {
    try {
      const response = await handler(await toRequest(req, host, port));
      res.writeHead(response.status, Object.fromEntries(response.headers));
      res.end(Buffer.from(await response.arrayBuffer()));
    } catch (error) {
      const status = error instanceof PayloadTooLarge ? 413 : 500;
      res.writeHead(status, { "content-type": "application/json" });
      res.end(
        JSON.stringify({ detail: status === 413 ? "Payload Too Large" : "Internal Server Error" }),
      );
    }
  });
  return new Promise((resolve) => server.listen(port, host, () => resolve(server)));
}

class PayloadTooLarge extends Error {}

async function toRequest(req: IncomingMessage, host: string, port: number): Promise<Request> {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? `${host}:${port}`}`);
  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (value !== undefined) headers.set(key, Array.isArray(value) ? value.join(", ") : value);
  }
  let body: Uint8Array<ArrayBuffer> | undefined;
  if (req.method !== "GET" && req.method !== "HEAD") {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of req) {
      size += (chunk as Buffer).length;
      if (size > MAX_BODY) throw new PayloadTooLarge();
      chunks.push(chunk as Buffer);
    }
    body = new Uint8Array(Buffer.concat(chunks));
  }
  return new Request(url, { method: req.method ?? "GET", headers, body });
}

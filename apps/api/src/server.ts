import { createServer } from "node:http";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { EdgeRequest, EdgeResponse } from "./edge-handler";

export const MAX_BODY_BYTES = 64 * 1024;

export type EdgeHandler = (request: EdgeRequest) => Promise<EdgeResponse>;

/**
 * Thin node:http adapter. It buffers the request body as raw bytes and hands them, untouched,
 * to the transport-neutral handler. No framework is used so there is no body-parser that
 * could re-serialize JSON before the signature is checked.
 */
export function createEdgeServer(handler: EdgeHandler): Server {
  return createServer((req, res) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let rejected = false;

    req.on("data", (chunk: Buffer) => {
      if (rejected) return;
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        rejected = true;
        res.writeHead(413, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: { code: "PAYLOAD_TOO_LARGE" } }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });

    req.on("end", () => {
      if (rejected) return;
      const headers: Record<string, string | undefined> = {};
      for (const [name, value] of Object.entries(req.headers)) {
        headers[name.toLowerCase()] = Array.isArray(value) ? value.join(", ") : value;
      }
      handler({
        method: req.method ?? "",
        target: req.url ?? "",
        headers,
        rawBody: new Uint8Array(Buffer.concat(chunks)),
      })
        .then((out) => {
          res.writeHead(out.status, { "Content-Type": "application/json" });
          res.end(JSON.stringify(out.body));
        })
        .catch(() => {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: { code: "INTERNAL_ERROR" } }));
        });
    });
  });
}

export type RunningServer = {
  readonly port: number;
  readonly baseUrl: string;
  close(): Promise<void>;
};

export function listen(server: Server, port = 0, host = "127.0.0.1"): Promise<RunningServer> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      const address = server.address() as AddressInfo;
      resolve({
        port: address.port,
        baseUrl: `http://${host}:${address.port}`,
        close: () =>
          new Promise<void>((done, fail) => {
            server.close((e) => (e ? fail(e) : done()));
            server.closeAllConnections();
          }),
      });
    });
  });
}

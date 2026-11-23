// A response sent on a request whose connection is already gone (05-surfaces §14): its socket null
// (what a destroyed request may show, depending on Node's version) or destroyed. Both are built
// here directly, not left to Node: the response ends on nothing, the gone socket is left alone, and
// nothing is thrown, since an error thrown here is answered by no one.

import { createServer, request } from "node:http";
import type { AddressInfo, Socket } from "node:net";
import { ContractError } from "@fluxvita/saveslot-service";
import { describe, expect, it } from "vitest";
import { sendError } from "./api.ts";

/**
 * One request, its body not read whole, its connection made gone as `how` says before an error
 * is sent on it. What was thrown, and whether `send` touched the gone socket (gave it a
 * `destroySoon` of its own).
 */
async function sentOnGone(
  how: "null" | "destroyed",
): Promise<{ thrown: unknown[]; touched: boolean }> {
  const thrown: unknown[] = [];
  let touched = false;
  let handled = () => {};
  const done = new Promise<void>((r) => {
    handled = r;
  });
  const server = createServer(async (req, res) => {
    const socket: Socket = req.socket;
    try {
      await req[Symbol.asyncIterator]().next();
      expect(req.complete).toBe(false);
      socket.destroy();
      if (how === "null") Object.defineProperty(req, "socket", { value: null, configurable: true });
      sendError(req, res, new ContractError("import_rejected", "cut", { reason: "incomplete" }));
      touched = Object.hasOwn(socket, "destroySoon");
    } catch (e) {
      thrown.push(e);
    } finally {
      handled();
    }
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const { port } = server.address() as AddressInfo;
  const client = request({
    host: "127.0.0.1",
    port,
    method: "POST",
    path: "/",
    headers: { "transfer-encoding": "chunked" },
  });
  client.on("error", () => {});
  client.on("response", (r) => r.resume());
  client.write("first");
  await done;
  client.destroy();
  await new Promise<void>((r) => server.close(() => r()));
  return { thrown, touched };
}

describe("an error sent on a request whose connection is gone", () => {
  it("its socket null: nothing thrown", async () => {
    expect(await sentOnGone("null")).toEqual({ thrown: [], touched: false });
  });

  it("its socket destroyed: nothing thrown, the socket left alone", async () => {
    expect(await sentOnGone("destroyed")).toEqual({ thrown: [], touched: false });
  });
});

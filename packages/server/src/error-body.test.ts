// The contract's error object (05-surfaces §3, §13): its detail, then its code and message, which no
// key of the detail can take the place of; HTTP and MCP give the same object.

import { ContractError } from "@fluxvita/saveslot-service";
import { expect, it } from "vitest";
import { errorBody } from "./api.ts";

it("a detail with a code or a message of its own does not replace the error's", () => {
  const e = new ContractError("invalid_argument", "the body is not JSON", {
    reason: "malformed",
    code: "ok",
    message: "all is well",
  } as never);
  expect(errorBody(e)).toEqual({
    reason: "malformed",
    code: "invalid_argument",
    message: "the body is not JSON",
  });
});

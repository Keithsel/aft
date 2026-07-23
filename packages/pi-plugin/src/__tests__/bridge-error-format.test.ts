import { describe, expect, test } from "bun:test";
import { toolErrorFromResponse } from "@cortexkit/aft-bridge";
import { formatBridgeErrorMessage } from "../tools/_shared.js";

describe("formatBridgeErrorMessage", () => {
  test("status_bar transport metadata never leaks into error data", () => {
    const message = formatBridgeErrorMessage("edit_match", {
      id: "42",
      success: false,
      code: "match_not_found",
      message: "edit_match: 'foo' not found in src/a.ts",
      status_bar: { errors: 0, warnings: 0, dead_code: 112, duplicates: 95 },
    });
    expect(message).toContain("match_not_found");
    expect(message).not.toContain("status_bar");
    expect(message).not.toContain("dead_code");
    // No real extras besides status_bar -> no data: block at all.
    expect(message).not.toContain("data:");
  });

  test("real structured extras still surface", () => {
    const message = formatBridgeErrorMessage("aft_import", {
      id: "7",
      success: false,
      code: "unsupported_grouped_import",
      message: "grouped import",
      conflicting_line: 12,
      status_bar: { errors: 1 },
    });
    expect(message).toContain("data:");
    expect(message).toContain("conflicting_line");
    expect(message).not.toContain("status_bar");
  });

  test("contract errors keep code before the exact normalized message", () => {
    const response = {
      id: "8",
      success: false,
      code: "invalid_request",
      message:
        "edit: top-level 'startLine' are invalid; line-range fields are valid only inside 'edits[]'. Use edits: [{ startLine, endLine, content }].",
      occurrences: [{ index: 1, line: 2, context: "hello" }],
    };
    const error = toolErrorFromResponse("edit", response);

    expect(error.code).toBe("invalid_request");
    expect(error.message).toBe(response.message);
    expect(error.response).toEqual(response);
    expect(error.cause.code).toBe("invalid_request");
    expect(error.cause.message).toBe(response.message);
    expect(error.cause.response.occurrences).toEqual(response.occurrences);
  });
});

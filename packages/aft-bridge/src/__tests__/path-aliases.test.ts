import { describe, expect, test } from "bun:test";
import {
  InvalidRequestError,
  isWellFormedUnicodeString,
  prepareCanonicalPathArguments,
} from "../path-aliases.js";

function expectInvalid(tool: string, args: unknown, fields: string[] = ["path", "filePath"]): void {
  try {
    prepareCanonicalPathArguments(tool, args);
    throw new Error("expected invalid_request");
  } catch (error) {
    expect(error).toBeInstanceOf(InvalidRequestError);
    expect((error as InvalidRequestError).code).toBe("invalid_request");
    for (const field of fields) expect((error as Error).message).toContain(field);
  }
}

describe("canonical path alias preparation", () => {
  test.each([
    ["canonical only", { path: "src/main.ts" }, { path: "src/main.ts" }],
    ["legacy only", { filePath: "src/main.ts" }, { path: "src/main.ts" }],
    [
      "equal dual spelling",
      { path: "src/main.ts", filePath: "src/main.ts" },
      { path: "src/main.ts" },
    ],
    [
      "equivalent JSON escapes",
      { path: "src/a.ts", filePath: "src/\u0061.ts" },
      { path: "src/a.ts" },
    ],
    [
      "supplementary character",
      { path: "src/😀.ts", filePath: "src/😀.ts" },
      { path: "src/😀.ts" },
    ],
  ])("accepts %s", (_label, input, expected) => {
    expect(prepareCanonicalPathArguments("read", input)).toEqual(expected);
  });

  test("compares decoded strings without path transformations", () => {
    const input = { path: " src\\main.ts ", filePath: "src/main.ts" };
    expectInvalid("read", input);
    expect(input).toEqual({ path: " src\\main.ts ", filePath: "src/main.ts" });
  });

  test("rejects unequal and incompatible dual spellings atomically", () => {
    expectInvalid("read", { path: "src/a.ts", filePath: "src/b.ts" });
    expectInvalid("read", { path: "src/a.ts", filePath: 42 });
    expectInvalid("read", { path: 42, filePath: "src/a.ts" });
  });

  test("does not normalize canonically distinct Unicode spellings", () => {
    expectInvalid("read", { path: "src/é.ts", filePath: "src/e\u0301.ts" });
  });

  test("requires a non-empty canonical path without trimming", () => {
    expectInvalid("read", { path: "" }, ["path"]);
    expectInvalid("read", { path: 42 }, ["path"]);
    expect(prepareCanonicalPathArguments("read", { path: " " }).path).toBe(" ");
  });

  test("rejects malformed UTF-16 at the preparation boundary", () => {
    expect(isWellFormedUnicodeString("😀")).toBe(true);
    expect(isWellFormedUnicodeString("\ud800")).toBe(false);
    expect(isWellFormedUnicodeString("\udc00")).toBe(false);
    expectInvalid("read", { path: "\ud800" }, ["path"]);
    expectInvalid("read", { path: "src/a.ts", filePath: "\ud800" });
  });

  test("normalizes nested zoom targets and callgraph target aliases", () => {
    expect(
      prepareCanonicalPathArguments("zoom", {
        targets: [{ filePath: "src/main.ts", symbol: "main" }],
      }),
    ).toEqual({ targets: [{ path: "src/main.ts", symbol: "main" }] });
    expect(
      prepareCanonicalPathArguments("callgraph", {
        path: "src/main.ts",
        toFile: "src/target.ts",
        op: "trace_to_symbol",
        symbol: "main",
        toSymbol: "target",
      }),
    ).toMatchObject({ path: "src/main.ts", toPath: "src/target.ts" });
    expectInvalid("callgraph", {
      path: "src/main.ts",
      filePath: "src/other.ts",
      symbol: "main",
      op: "callers",
    });
  });

  test("leaves role-specific collection and destination properties unchanged", () => {
    const input = {
      files: ["src/a.ts"],
      destination: "src/b.ts",
      target: "src/c.ts",
      path: "src/main.ts",
    };
    expect(prepareCanonicalPathArguments("move", input)).toEqual({
      ...input,
    });
  });
});

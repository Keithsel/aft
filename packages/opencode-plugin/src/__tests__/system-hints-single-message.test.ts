import { describe, expect, test } from "bun:test";

import { appendHintsToSystem } from "../workflow-hints";

// Strict Qwen-family chat templates (vLLM/SGLang, and LiteLLM fronting them)
// reject any role:"system" message past index 0. The host maps each system[]
// entry to its own system message, so the hints block must never add an entry
// when one already exists. This suite pins the single-message property; the
// strict-template simulation below is the oracle that fails if anyone reverts
// to system.push().
function strictTemplateAccepts(system: string[]): boolean {
  // Model of the Qwen template guard: every system message must sit at
  // index 0, which is only satisfiable when there is at most one entry.
  return system.length <= 1;
}

describe("appendHintsToSystem", () => {
  test("extends the existing entry instead of adding a second system message", () => {
    const system = ["host prompt"];
    appendHintsToSystem(system, "HINTS");
    expect(system).toHaveLength(1);
    expect(system[0]).toBe("host prompt\n\nHINTS");
    expect(strictTemplateAccepts(system)).toBe(true);
  });

  test("still delivers hints when the host provided no system prompt", () => {
    const system: string[] = [];
    appendHintsToSystem(system, "HINTS");
    expect(system).toEqual(["HINTS"]);
    expect(strictTemplateAccepts(system)).toBe(true);
  });

  test("keeps the host prompt bytes as a prefix (prompt-cache stability)", () => {
    const system = ["host prompt"];
    appendHintsToSystem(system, "HINTS");
    expect(system[0].startsWith("host prompt")).toBe(true);
  });

  test("empty hints block leaves the array untouched", () => {
    const system = ["host prompt"];
    appendHintsToSystem(system, "");
    expect(system).toEqual(["host prompt"]);
  });

  test("negative control: the old push behavior fails the strict template", () => {
    // This is what the plugin used to do. If someone reintroduces it, the
    // strict-template oracle above must reject the result — proving the
    // oracle is capable of failing.
    const system = ["host prompt"];
    system.push("HINTS");
    expect(strictTemplateAccepts(system)).toBe(false);
  });
});

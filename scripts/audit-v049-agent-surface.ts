#!/usr/bin/env bun
/**
 * Audit and capture the v0.49 agent publication surface.
 *
 * The audit intentionally has two independent checks: source text occurrences
 * are checked against a location-level allowlist, while the production builders
 * and generated subc artifact are inspected as emitted agent bytes. This keeps
 * compatibility plumbing available without allowing retired vocabulary into a
 * schema, description, prompt, guideline, README, or current tool reference.
 *
 * Usage:
 *   bun scripts/audit-v049-agent-surface.ts --write-allowlist --write-prefix-capture --write-manifest
 *   bun scripts/audit-v049-agent-surface.ts
 */

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tool } from "../packages/opencode-plugin/node_modules/@opencode-ai/plugin/dist/index.js";
import { buildOpenCodeToolMap } from "../packages/opencode-plugin/src/tool-registration.ts";
import {
  buildHintsFromConfig as buildOpenCodeHints,
} from "../packages/opencode-plugin/src/workflow-hints.ts";
import {
  registerPiToolSurface,
  resolvePiToolSurface,
} from "../packages/pi-plugin/src/tool-registration.ts";
import { buildHintsFromConfig as buildPiHints } from "../packages/pi-plugin/src/workflow-hints.ts";

const ROOT = resolve(import.meta.dir, "..");
const SOURCE_INVENTORY_PATH = "docs/v0.49-agent-surface-sources.json";
const ALLOWLIST_PATH = "docs/v0.49-legacy-vocabulary-allowlist.json";
const PREFIX_CAPTURE_PATH = "docs/v0.49-agent-prefix-capture.json";
const MANIFEST_PATH = "docs/v0.49-agent-surface-manifest.json";
const SUBC_SCHEMA_PATH = "crates/aft/src/subc_tool_schemas.json";
const LEGACY = ["filePath", "toFile"] as const;

interface Surface {
  id: string;
  path: string;
  kind: string;
  owner: string;
  profiles: string[];
  prohibited: boolean;
}

interface SourceInventory {
  artifact_id: string;
  manifest_id: string;
  surfaces: Surface[];
  excluded_historical_surfaces: Array<{ path: string; class: string; reason: string }>;
}

interface AllowlistEntry {
  path: string;
  location: string;
  line: number;
  column: number;
  token: string;
  class: string;
  reason: string;
}

interface Allowlist {
  artifact_id: string;
  artifact_version: string;
  vocabulary: string[];
  entries: AllowlistEntry[];
}

type JsonObject = Record<string, unknown>;

type Profile = {
  id: string;
  harness: "opencode" | "pi";
  surface: "minimal" | "recommended" | "all";
};

const sourceInventory = JSON.parse(
  readFileSync(join(ROOT, SOURCE_INVENTORY_PATH), "utf8"),
) as SourceInventory;
const surfaceByPath = new Map(sourceInventory.surfaces.map((surface) => [surface.path, surface]));
const excludedPaths = new Map(
  sourceInventory.excluded_historical_surfaces.map((entry) => [entry.path, entry]),
);

const profiles: Profile[] = [
  { id: "REG-V049-OC-MIN", harness: "opencode", surface: "minimal" },
  { id: "REG-V049-OC-REC", harness: "opencode", surface: "recommended" },
  { id: "REG-V049-OC-ALL", harness: "opencode", surface: "all" },
  { id: "REG-V049-PI-MIN", harness: "pi", surface: "minimal" },
  { id: "REG-V049-PI-REC", harness: "pi", surface: "recommended" },
  { id: "REG-V049-PI-ALL", harness: "pi", surface: "all" },
];

const profileConfigs: Record<string, Record<string, unknown>> = {
  "REG-V049-OC-MIN": { tool_surface: "minimal", backup: { enabled: true }, bash: false },
  "REG-V049-OC-REC": {
    tool_surface: "recommended",
    hoist_builtin_tools: true,
    backup: { enabled: true },
    bash: true,
    search_index: true,
    semantic_search: true,
  },
  "REG-V049-OC-ALL": {
    tool_surface: "all",
    hoist_builtin_tools: true,
    backup: { enabled: true },
    bash: true,
    search_index: true,
    semantic_search: true,
  },
  "REG-V049-PI-MIN": { tool_surface: "minimal", backup: { enabled: true }, bash: false },
  "REG-V049-PI-REC": {
    tool_surface: "recommended",
    backup: { enabled: true },
    bash: true,
    search_index: true,
    semantic_search: true,
  },
  "REG-V049-PI-ALL": {
    tool_surface: "all",
    backup: { enabled: true },
    bash: true,
    search_index: true,
    semantic_search: true,
  },
};

function git(args: string[]): string {
  return execFileSync("git", args, { cwd: ROOT, encoding: "utf8" }).trim();
}

function sourceCommit(): string {
  return git(["rev-parse", "HEAD"]);
}

function trackedFiles(): string[] {
  const tracked = git(["ls-files", "-z"])
    .split("\0")
    .filter(Boolean)
    .filter((path) => !path.startsWith(".cortexkit/") && !path.startsWith(".alfonso/"));
  // Include this not-yet-committed checker while it is being bootstrapped so
  // its own vocabulary literals receive the same location-level review.
  if (existsSync(join(ROOT, "scripts/audit-v049-agent-surface.ts")) && !tracked.includes("scripts/audit-v049-agent-surface.ts")) {
    tracked.push("scripts/audit-v049-agent-surface.ts");
  }
  return tracked;
}

function textFile(path: string): boolean {
  const bytes = readFileSync(join(ROOT, path));
  return !bytes.subarray(0, 4096).includes(0);
}

function occurrenceEntries(): AllowlistEntry[] {
  const entries: AllowlistEntry[] = [];
  for (const path of trackedFiles()) {
    if (
      path === ALLOWLIST_PATH ||
      path === SOURCE_INVENTORY_PATH ||
      path === MANIFEST_PATH ||
      path === PREFIX_CAPTURE_PATH ||
      !existsSync(join(ROOT, path)) ||
      !textFile(path)
    ) {
      continue;
    }
    const lines = readFileSync(join(ROOT, path), "utf8").split("\n");
    for (const [lineIndex, line] of lines.entries()) {
      for (const token of LEGACY) {
        let start = 0;
        while (true) {
          const column = line.indexOf(token, start);
          if (column < 0) break;
          entries.push({
            path,
            location: `line ${lineIndex + 1}, column ${column + 1}`,
            line: lineIndex + 1,
            column: column + 1,
            token,
            ...classifyOccurrence(path, line),
          });
          start = column + token.length;
        }
      }
    }
  }
  return entries;
}

function classifyOccurrence(path: string, line: string): { class: string; reason: string } {
  const historical = excludedPaths.get(path);
  if (historical) return { class: historical.class, reason: historical.reason };
  const surface = surfaceByPath.get(path);
  if (surface?.prohibited) {
    const agentText =
      /description|prompt|guideline|Example|example|README|documentation|`[^`]*(filePath|toFile)/i.test(
        line,
      );
    if (agentText) {
      return {
        class: "prohibited-agent-surface",
        reason: "Retired vocabulary is not permitted in emitted schema or agent steering text.",
      };
    }
    return {
      class: "compatibility-boundary",
      reason: "The spelling is retained only for raw-input compatibility or an internal bridge payload.",
    };
  }
  if (path.startsWith("crates/aft/tests/fixtures/") || path.includes("/__tests__/")) {
    return {
      class: "compatibility-fixture",
      reason: "The fixture submits or asserts a retired input spelling at a compatibility boundary.",
    };
  }
  if (path.startsWith("scripts/")) {
    return {
      class: "audit-implementation",
      reason: "The audit or capture implementation names the vocabulary it checks.",
    };
  }
  if (path.startsWith("crates/aft/src/")) {
    return {
      class: "rust-compatibility",
      reason: "Rust command, translation, or protocol plumbing consumes the legacy wire spelling.",
    };
  }
  return {
    class: "internal-compatibility",
    reason: "The spelling is an internal variable, payload, migration, or historical compatibility reference.",
  };
}

function writeAllowlist(): Allowlist {
  const allowlist: Allowlist = {
    artifact_id: "LIST-V049-LEGACY-VOCABULARY-001",
    artifact_version: "0.49.0",
    vocabulary: [...LEGACY],
    entries: occurrenceEntries(),
  };
  writeFileSync(join(ROOT, ALLOWLIST_PATH), `${JSON.stringify(allowlist, null, 2)}\n`, "utf8");
  return allowlist;
}

function loadAllowlist(): Allowlist {
  if (!existsSync(join(ROOT, ALLOWLIST_PATH))) return writeAllowlist();
  return JSON.parse(readFileSync(join(ROOT, ALLOWLIST_PATH), "utf8")) as Allowlist;
}

function occurrenceKey(entry: Pick<AllowlistEntry, "path" | "line" | "column" | "token">): string {
  return `${entry.path}:${entry.line}:${entry.column}:${entry.token}`;
}

function auditSourceOccurrences(allowlist: Allowlist): void {
  const expected = occurrenceEntries();
  const checked = new Map(allowlist.entries.map((entry) => [occurrenceKey(entry), entry]));
  const failures: string[] = [];
  for (const occurrence of expected) {
    const entry = checked.get(occurrenceKey(occurrence));
    if (!entry) {
      failures.push(`${occurrence.path}:${occurrence.line}:${occurrence.column} ${occurrence.token} is not allowlisted`);
      continue;
    }
    if (!entry.class || !entry.reason || !entry.location) {
      failures.push(`${occurrenceKey(occurrence)} is missing checked location, class, or reason`);
    }
    if (entry.class === "prohibited-agent-surface") {
      failures.push(`${occurrenceKey(occurrence)} remains on a prohibited agent-visible surface`);
    }
  }
  for (const entry of allowlist.entries) {
    if (!expected.some((occurrence) => occurrenceKey(occurrence) === occurrenceKey(entry))) {
      failures.push(`${occurrenceKey(entry)} is stale in the allowlist`);
    }
  }
  if (failures.length > 0) throw new Error(`legacy vocabulary audit failed:\n${failures.join("\n")}`);
}

function stubContext(config: Record<string, unknown>): unknown {
  return {
    pool: { getBridge: () => { throw new Error("surface capture must not touch the bridge"); } },
    client: { lsp: {}, find: {} },
    config,
    storageDir: "/tmp/aft-v049-agent-surface",
  };
}

function jsonSchemaForOpenCode(definition: { args: Record<string, unknown> }): JsonObject {
  return tool.schema.toJSONSchema(tool.schema.object(definition.args), { io: "input" }) as JsonObject;
}

function captureOpenCode(config: Record<string, unknown>): Record<string, unknown> {
  const definitions = buildOpenCodeToolMap(stubContext(config) as never, config as never);
  return Object.fromEntries(
    Object.entries(definitions).map(([name, definition]) => [
      name,
      {
        description: definition.description,
        schema: jsonSchemaForOpenCode(definition as unknown as { args: Record<string, unknown> }),
      },
    ]),
  );
}

function capturePi(config: Record<string, unknown>): Record<string, unknown> {
  const definitions = new Map<string, Record<string, unknown>>();
  const pi = {
    registerTool(definition: Record<string, unknown>) {
      const { execute: _execute, renderCall: _renderCall, renderResult: _renderResult, ...agentDefinition } = definition;
      definitions.set(String(definition.name), agentDefinition);
    },
  };
  registerPiToolSurface(pi as never, stubContext(config) as never, resolvePiToolSurface(config as never));
  return Object.fromEntries(definitions);
}

function buildHints(harness: "opencode" | "pi", config: Record<string, unknown>, names: string[]): string | null {
  const known = [
    "aft_outline", "aft_zoom", "aft_search", "aft_callgraph", "aft_inspect",
    "grep", "aft_grep", "bash", "aft_bash", "bash_status",
  ];
  const absent = new Set(known.filter((name) => !names.includes(name)));
  return harness === "opencode"
    ? buildOpenCodeHints(config as never, absent)
    : buildPiHints(config as never, absent, true);
}

function hostVersion(command: string): { value: string | null; method: string } {
  try {
    const value = execFileSync(command, ["--version"], { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    return { value: value || null, method: `${command} --version` };
  } catch {
    return { value: null, method: `${command} --version (not available in capture environment)` };
  }
}

function productionCacheKey(harness: "opencode" | "pi"): { value: string | null; exposed: boolean; source: string } {
  const names = harness === "opencode"
    ? ["OPENCODE_PRODUCTION_CACHE_KEY", "OPENCODE_PLUGIN_CACHE_KEY"]
    : ["PI_PRODUCTION_CACHE_KEY", "PI_PLUGIN_CACHE_KEY"];
  for (const name of names) {
    const value = process.env[name];
    if (value) return { value, exposed: true, source: `environment:${name}` };
  }
  return { value: null, exposed: false, source: "host did not expose a production cache key" };
}

function capturePrefixInput(commit: string): JsonObject {
  const captures = profiles.map((profile) => {
    const config = profileConfigs[profile.id];
    const input = profile.harness === "opencode" ? captureOpenCode(config) : capturePi(config);
    const names = Object.keys(input).sort();
    return {
      capture_id: `PREFIX-${profile.id}`,
      profile_id: profile.id,
      harness: profile.harness,
      host_version: hostVersion(profile.harness === "opencode" ? "opencode" : "pi"),
      capture_method: profile.harness === "opencode"
        ? "production buildOpenCodeToolMap registration output plus system-transform workflow hint input"
        : "production registerPiToolSurface registration output plus before_agent_start workflow hint input",
      production_cache_key: productionCacheKey(profile.harness),
      source_commit: commit,
      prefix_input: {
        registered_tool_names: names,
        tools: input,
        workflow_hints: buildHints(profile.harness, config, names),
      },
    };
  });
  return {
    artifact_id: "ART-V049-S5-AGENT-PREFIX-CAPTURE-001",
    artifact_version: "0.49.0",
    source_commit: commit,
    capture_scope: "complete plugin-owned production agent-prefix input for every checked host profile; host-owned base prompt text is outside the plugin boundary",
    captures,
  };
}

function assertNoLegacy(value: unknown, label: string): void {
  const serialized = JSON.stringify(value);
  for (const token of LEGACY) {
    if (serialized.includes(token)) throw new Error(`${label} contains prohibited ${token}`);
  }
}

function auditEmittedSurfaces(): void {
  const subc = JSON.parse(readFileSync(join(ROOT, SUBC_SCHEMA_PATH), "utf8")) as JsonObject;
  assertNoLegacy(subc, SUBC_SCHEMA_PATH);
  for (const profile of profiles) {
    const config = profileConfigs[profile.id];
    const emitted = profile.harness === "opencode" ? captureOpenCode(config) : capturePi(config);
    assertNoLegacy(emitted, profile.id);
    if (profile.surface === "all") {
      for (const [name, definition] of Object.entries(emitted)) {
        const serialized = JSON.stringify(definition);
        if (name === "read" || name === "write" || name === "edit") {
          if (!serialized.includes('"path"')) throw new Error(`${profile.id} ${name} does not expose path`);
        }
      }
    }
  }
}

function exactArtifact(path: string): JsonObject {
  const bytes = readFileSync(join(ROOT, path));
  return {
    path,
    encoding: "UTF-8",
    byte_length: bytes.byteLength,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
}

function writePrefixCapture(commit: string): JsonObject {
  const capture = capturePrefixInput(commit);
  writeFileSync(join(ROOT, PREFIX_CAPTURE_PATH), `${JSON.stringify(capture, null, 2)}\n`, "utf8");
  return capture;
}

function writeManifest(commit: string): void {
  const artifacts = sourceInventory.surfaces.map((surface) => ({
    id: surface.id.replace("SURFACE", "ART") + "-BYTES",
    path: surface.path,
    kind: surface.kind,
    owner: surface.owner,
    profiles: surface.profiles,
    source_commit: commit,
    ...exactArtifact(surface.path),
  }));
  artifacts.push({
    id: "ART-V049-S5-SOURCE-INVENTORY-001",
    path: SOURCE_INVENTORY_PATH,
    kind: "checked publication-surface source inventory",
    owner: "publication-audit",
    profiles: profiles.map((profile) => profile.id),
    source_commit: commit,
    ...exactArtifact(SOURCE_INVENTORY_PATH),
  });
  artifacts.push({
    id: "LIST-V049-LEGACY-VOCABULARY-001",
    path: ALLOWLIST_PATH,
    kind: "checked legacy-vocabulary allowlist",
    owner: "publication-audit",
    profiles: profiles.map((profile) => profile.id),
    source_commit: commit,
    ...exactArtifact(ALLOWLIST_PATH),
  });
  artifacts.push({
    id: "ART-V049-S5-AUDIT-IMPLEMENTATION-001",
    path: "scripts/audit-v049-agent-surface.ts",
    kind: "audit and capture harness",
    owner: "publication-audit",
    profiles: profiles.map((profile) => profile.id),
    source_commit: commit,
    ...exactArtifact("scripts/audit-v049-agent-surface.ts"),
  });
  if (existsSync(join(ROOT, PREFIX_CAPTURE_PATH))) {
    artifacts.push({
      id: "ART-V049-S5-AGENT-PREFIX-CAPTURE-001",
      path: PREFIX_CAPTURE_PATH,
      kind: "production agent-prefix capture",
      owner: "host-instrumentation",
      profiles: profiles.map((profile) => profile.id),
      source_commit: commit,
      ...exactArtifact(PREFIX_CAPTURE_PATH),
    });
  }
  const manifest = {
    "$schema": "https://json-schema.org/draft/2020-12/schema",
    "artifact_id": "ART-V049-S5-AGENT-SURFACE-MANIFEST-001",
    "artifact_version": "0.49.0",
    "manifest_id": "MAN-V049-S5-AGENT-SURFACE-001",
    "source_commit": commit,
    "source_inventory": SOURCE_INVENTORY_PATH,
    "hash_rule": "Hash exact UTF-8 file bytes from the source commit; do not normalize newlines, reserialize JSON, or apply test-only normalization.",
    "artifacts": artifacts,
  };
  writeFileSync(join(ROOT, MANIFEST_PATH), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
}

function verifyManifest(): void {
  const manifest = JSON.parse(readFileSync(join(ROOT, MANIFEST_PATH), "utf8")) as {
    source_commit: string;
    artifacts: Array<JsonObject & { path: string; source_commit: string; byte_length: number; sha256: string }>;
  };
  if (!manifest.source_commit || manifest.artifacts.length === 0) throw new Error("agent-surface manifest is empty");
  const commits = new Set(manifest.artifacts.map((artifact) => artifact.source_commit));
  if (commits.size !== 1 || !commits.has(manifest.source_commit)) throw new Error("artifacts do not share one source commit");
  for (const artifact of manifest.artifacts) {
    const actual = exactArtifact(artifact.path);
    if (actual.byte_length !== artifact.byte_length || actual.sha256 !== artifact.sha256) {
      throw new Error(`exact bytes changed for ${artifact.path}; regenerate the manifest`);
    }
  }
}

function main(): void {
  const args = new Set(process.argv.slice(2));
  const commit = sourceCommit();
  const allowlist = args.has("--write-allowlist") ? writeAllowlist() : loadAllowlist();
  auditSourceOccurrences(allowlist);
  auditEmittedSurfaces();
  if (args.has("--write-prefix-capture")) writePrefixCapture(commit);
  if (args.has("--write-manifest")) writeManifest(commit);
  if (existsSync(join(ROOT, PREFIX_CAPTURE_PATH))) {
    assertNoLegacy(JSON.parse(readFileSync(join(ROOT, PREFIX_CAPTURE_PATH), "utf8")), PREFIX_CAPTURE_PATH);
  }
  if (existsSync(join(ROOT, MANIFEST_PATH))) verifyManifest();
  console.log(`v0.49 agent surface audit passed (${commit})`);
}

main();

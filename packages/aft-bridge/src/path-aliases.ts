/**
 * Canonical path aliases accepted at host and subc preparation boundaries.
 *
 * Compatibility is intentionally about decoded string values only. The
 * preparation layer must not trim, normalize, fold case, rewrite separators,
 * or resolve paths before comparing the two spellings.
 */

export type CanonicalPathTool =
  | "read"
  | "write"
  | "edit"
  | "zoom"
  | "callgraph"
  | "safety"
  | "move"
  | "import"
  | "refactor"
  | "grep"
  | "search"
  | "conflicts";

export class InvalidRequestError extends Error {
  readonly code = "invalid_request" as const;

  constructor(message: string) {
    super(message);
    this.name = "InvalidRequestError";
  }
}

/** Return false for lone UTF-16 surrogate code units. */
export function isWellFormedUnicodeString(value: string): boolean {
  for (let index = 0; index < value.length; index++) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next < 0xdc00 || next > 0xdfff || Number.isNaN(next)) return false;
      index++;
    } else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      return false;
    }
  }
  return true;
}

function hasOwn(record: Record<string, unknown>, key: string): boolean {
  return Object.hasOwn(record, key);
}

function invalidPathValue(property: string): never {
  throw new InvalidRequestError(`'${property}' must be a non-empty well-formed Unicode string`);
}

function pathValue(record: Record<string, unknown>, property: string): string {
  const value = record[property];
  if (typeof value !== "string" || value.length === 0 || !isWellFormedUnicodeString(value)) {
    invalidPathValue(property);
  }
  return value;
}

function normalizeAliasPair(
  record: Record<string, unknown>,
  canonical: string,
  legacy: string,
  required: boolean,
): void {
  const hasCanonical = hasOwn(record, canonical);
  const hasLegacy = hasOwn(record, legacy);

  if (!hasCanonical && !hasLegacy) {
    if (required) {
      throw new InvalidRequestError(`'${canonical}' is required`);
    }
    return;
  }

  if (hasCanonical && hasLegacy) {
    let canonicalValue: string;
    let legacyValue: string;
    try {
      canonicalValue = pathValue(record, canonical);
      legacyValue = pathValue(record, legacy);
    } catch {
      throw new InvalidRequestError(
        `Invalid request: '${canonical}' and '${legacy}' must both be non-empty well-formed Unicode strings`,
      );
    }
    if (canonicalValue !== legacyValue) {
      throw new InvalidRequestError(
        `Invalid request: '${canonical}' and '${legacy}' must contain equal decoded strings`,
      );
    }
    delete record[legacy];
    return;
  }

  if (hasCanonical) {
    pathValue(record, canonical);
    return;
  }

  record[canonical] = pathValue(record, legacy);
  delete record[legacy];
}

function validateOptionalCanonicalPath(record: Record<string, unknown>, property: string): void {
  if (hasOwn(record, property)) pathValue(record, property);
}

function normalizeZoomTargets(record: Record<string, unknown>): void {
  if (!hasOwn(record, "targets")) return;
  const targets = record.targets;
  const normalizeTarget = (target: unknown, index: number): Record<string, unknown> => {
    if (!target || typeof target !== "object" || Array.isArray(target)) {
      throw new InvalidRequestError(`'targets[${index}].path' must be a non-empty string`);
    }
    const source = target as Record<string, unknown>;
    // Model calls sometimes serialize an omitted target as an entirely empty
    // target object. Preserve that sentinel so the tool can ignore it while
    // still rejecting any target that supplies a real symbol with an empty path.
    const emptyTarget =
      source.symbol === "" &&
      ((hasOwn(source, "path") && source.path === "") ||
        (hasOwn(source, "filePath") && source.filePath === ""));
    if (emptyTarget) return { ...source };
    const normalized = { ...source };
    try {
      normalizeAliasPair(normalized, "path", "filePath", true);
    } catch (error) {
      if (error instanceof InvalidRequestError) {
        throw new InvalidRequestError(
          error.message
            .replace("'filePath'", `'targets[${index}].filePath'`)
            .replace("'path'", `'targets[${index}].path'`),
        );
      }
      throw error;
    }
    return normalized;
  };

  if (Array.isArray(targets)) {
    if (targets.length === 0) return;
    record.targets = targets.map(normalizeTarget);
    return;
  }

  if (targets && typeof targets === "object") {
    record.targets = normalizeTarget(targets, 0);
  }
}

function bareToolName(toolName: string): CanonicalPathTool | undefined {
  const bare = toolName.startsWith("aft_") ? toolName.slice(4) : toolName;
  if (
    bare === "read" ||
    bare === "write" ||
    bare === "edit" ||
    bare === "zoom" ||
    bare === "callgraph" ||
    bare === "safety" ||
    bare === "move" ||
    bare === "import" ||
    bare === "refactor" ||
    bare === "grep" ||
    bare === "search" ||
    bare === "conflicts"
  ) {
    return bare;
  }
  return undefined;
}

/**
 * Prepare raw arguments for one registered tool before schema validation.
 *
 * The returned object is a fresh object, and nested zoom targets are copied,
 * so an alias conflict or invalid value cannot partially mutate caller state.
 */
export function prepareCanonicalPathArguments(
  toolName: string,
  rawArguments: unknown,
): Record<string, unknown> {
  if (!rawArguments || typeof rawArguments !== "object" || Array.isArray(rawArguments)) {
    throw new InvalidRequestError("tool arguments must be an object");
  }

  const tool = bareToolName(toolName);
  const record = { ...(rawArguments as Record<string, unknown>) };
  if (!tool) return record;

  switch (tool) {
    case "read":
    case "write":
    case "edit":
    case "move":
    case "import":
    case "refactor":
      normalizeAliasPair(record, "path", "filePath", true);
      break;
    case "zoom":
      normalizeAliasPair(record, "path", "filePath", false);
      normalizeZoomTargets(record);
      break;
    case "callgraph":
      normalizeAliasPair(record, "path", "filePath", true);
      normalizeAliasPair(record, "toPath", "toFile", false);
      break;
    case "safety":
      normalizeAliasPair(record, "path", "filePath", false);
      break;
    case "grep":
    case "search":
    case "conflicts":
      validateOptionalCanonicalPath(record, "path");
      break;
  }

  return record;
}

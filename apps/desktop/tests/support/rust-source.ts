/**
 * Reads the authoritative protocol sources from the repository so the desktop's
 * wire tests can fail on DRIFT rather than on a hand-copied literal.
 *
 * The Rust crate is the source of truth (`schemas/README.md`); the JSON schemas
 * are hand-synced to it and gated by `make schema-drift`. A TS test that only
 * compares `METHODS` to a literal written in the same file proves nothing — it
 * passes even when the mirror has rotted. Everything here is parsed out of the
 * actual files on disk, so a rename or a removed method in Rust breaks this suite.
 *
 * If a source file cannot be read, the helper throws: a test that silently
 * skipped because Core was absent would be a false green (AGENTS rule 5).
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

/**
 * tests/support → tests → desktop → apps → repo root: FOUR levels up.
 *
 * (Three lands on `apps/`, which produces the same class of wrong-path failure
 * this revision fixed in `src-tauri/Cargo.toml` — resolved to
 * `apps/core/crates/sandpane-protocol` and could never find the crate.)
 */
export const REPO_ROOT = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
  "..",
);

function read(relative: string): string {
  const path = join(REPO_ROOT, relative);
  try {
    return readFileSync(path, "utf8");
  } catch (err) {
    throw new Error(
      `cannot read protocol source ${path} (${String(err)}) — the drift gate is ` +
        `only meaningful when the authoritative files are present`,
    );
  }
}

export const PROTOCOL_RUST = "core/crates/sandpane-protocol/src/lib.rs";
export const SERVICE_RUST = "core/crates/sandpane-service/src/lib.rs";
export const RPC_REQUEST_SCHEMA = "schemas/rpc-request.schema.json";

export function protocolRustSource(): string {
  return read(PROTOCOL_RUST);
}

export function serviceRustSource(): string {
  return read(SERVICE_RUST);
}

export function readSchema<T = unknown>(name: string): T {
  return JSON.parse(read(`schemas/${name}.schema.json`)) as T;
}

/**
 * `#[serde(rename = "a.b")] Variant,` pairs inside `pub enum Method`.
 *
 * Scoped to the enum body on purpose: `AgentEvent` uses the same rename
 * attribute for dotted tags, and mixing the two would make a drift in one
 * invisible to the other.
 */
export function rustMethodRenames(): string[] {
  const source = protocolRustSource();
  const start = source.indexOf("pub enum Method {");
  if (start < 0) throw new Error(`${PROTOCOL_RUST} has no "pub enum Method {"`);
  const end = source.indexOf("}", start);
  const body = source.slice(start, end);
  const pairs = [...body.matchAll(/#\[serde\(rename = "([a-z][a-z0-9_]*\.[a-z][a-z0-9_]*)"\)\]\s*\n\s*([A-Z][A-Za-z0-9]*),/g)];
  if (pairs.length === 0) throw new Error("no #[serde(rename)] variants parsed from pub enum Method");
  return pairs.map((pair) => pair[1] as string);
}

/**
 * `Method::ALL` resolved to wire names, in declared order, together with the
 * length written in the array type. `CoreCapabilities.methods` is derived from
 * this list, so its ORDER is part of the contract this client mirrors.
 */
export function rustMethodAll(): { names: string[]; declaredLength: number } {
  const source = protocolRustSource();
  const decl = /pub const ALL: \[Method; (\d+)\] = \[(.*?)\];/s.exec(source);
  if (!decl) throw new Error(`${PROTOCOL_RUST} has no "pub const ALL: [Method; N] = [...]"`);
  const declaredLength = Number(decl[1]);
  const variants = [...decl[2].matchAll(/Self::([A-Z][A-Za-z0-9]*),/g)].map((m) => m[1] as string);
  // Variant order inside the enum body is the same order `ALL` lists; pair them
  // positionally so a renamed variant with a renamed wire string still resolves.
  const renames = rustMethodRenames();
  const body = source.slice(source.indexOf("pub enum Method {"), source.indexOf("}", source.indexOf("pub enum Method {")));
  const orderedVariants = [...body.matchAll(/#\[serde\(rename = "[^"]+"\)\]\s*\n\s*([A-Z][A-Za-z0-9]*),/g)].map((m) => m[1] as string);
  const names = variants.map((variant) => {
    const index = orderedVariants.indexOf(variant);
    if (index < 0) throw new Error(`Method::ALL names ${variant}, which the enum does not declare`);
    return renames[index] as string;
  });
  return { names, declaredLength };
}

/** `pub const NAME: <type> = <literal>;` from the service crate. */
export function rustServiceConst(name: string): number {
  return constFrom(serviceRustSource(), SERVICE_RUST, name);
}

/** `pub const PROTOCOL_VERSION: u32 = 1;` from the protocol crate. */
export function rustProtocolVersionConst(): number {
  return constFrom(protocolRustSource(), PROTOCOL_RUST, "PROTOCOL_VERSION");
}

function constFrom(source: string, file: string, name: string): number {
  const found = new RegExp(`pub const ${name}: [A-Za-z0-9_<>\\[\\]]+ = ([^;\\n]+);`).exec(source);
  const value = found?.[1]?.trim();
  if (value === undefined || value === "") {
    throw new Error(`${file} has no parseable "pub const ${name}: _ = _;"`);
  }
  // Only arithmetic on integer literals is understood (`4 * 1024 * 1024`).
  if (!/^[\d\s*]+$/.test(value)) throw new Error(`unsupported const expression for ${name}: ${value}`);
  return value.split("*").reduce((product, part) => product * Number(part.trim()), 1);
}

/** The method enum from the RPC request schema (the shipped contract). */
export function schemaMethodEnum(): string[] {
  const schema = readSchema<{ properties: { method: { enum: string[] } } }>(
    "rpc-request",
  );
  return schema.properties.method.enum;
}

/** `properties` keys of a schema, for additive-field presence checks. */
export function schemaPropertyNames(name: string): string[] {
  const schema = readSchema<{ properties?: Record<string, unknown> }>(name);
  return Object.keys(schema.properties ?? {});
}

/** Required keys of an object schema. */
export function schemaRequired(name: string): string[] {
  const schema = readSchema<{ required?: string[] }>(name);
  return schema.required ?? [];
}

/** True when the Rust struct field exists with this exact declaration text. */
export function rustFieldExists(declaration: string): boolean {
  return protocolRustSource().includes(declaration);
}

/** The desktop's own Rust proxy (src-tauri), read from disk like the Core crates. */
export const DESKTOP_PROXY_RUST = "apps/desktop/src-tauri/src/ipc_client.rs";

export function desktopProxyRustSource(): string {
  return read(DESKTOP_PROXY_RUST);
}

/** Resolve a `Method` variant name (e.g. `SystemProbe`) to its wire name. */
export function rustMethodWireName(variant: string): string {
  const source = protocolRustSource();
  const start = source.indexOf("pub enum Method {");
  const body = source.slice(start, source.indexOf("}", start));
  const ordered = [...body.matchAll(/#\[serde\(rename = "[^"]+"\)\]\s*\n\s*([A-Z][A-Za-z0-9]*),/g)].map(
    (m) => m[1] as string,
  );
  const index = ordered.indexOf(variant);
  if (index < 0) throw new Error(`Method has no variant ${variant}`);
  return rustMethodRenames()[index] as string;
}

/**
 * Wire names of a `#[serde(rename_all = "snake_case")]` unit enum in the
 * protocol crate, in declared order (`TaskStatus`, `FileChangeStatus`,
 * `WorkspaceMode`).
 *
 * Fails loudly — never returns an empty list — when the enum is missing, when
 * its attribute block does not carry `rename_all = "snake_case"` (the PascalCase
 * → snake_case conversion below would then be wrong), or when no variant
 * parses. Doc comments and attributes are skipped; a per-variant
 * `#[serde(rename = "...")]` wins over the conversion.
 */
export function rustSnakeCaseEnumVariants(name: string): string[] {
  const source = protocolRustSource();
  const marker = `pub enum ${name} {`;
  const start = source.indexOf(marker);
  if (start < 0) throw new Error(`${PROTOCOL_RUST} has no "${marker}"`);
  // The attribute block: the lines directly above the enum, up to the previous
  // blank line or item.
  const before = source.slice(0, start).split("\n");
  const attrs: string[] = [];
  for (let i = before.length - 2; i >= 0; i -= 1) {
    const line = (before[i] ?? "").trim();
    if (!(line.startsWith("#[") || line.startsWith("///"))) break;
    attrs.push(line);
  }
  if (!attrs.some((line) => line.includes('#[serde(rename_all = "snake_case")]'))) {
    throw new Error(`pub enum ${name} is not #[serde(rename_all = "snake_case")]`);
  }
  const end = source.indexOf("\n}", start);
  if (end < 0) throw new Error(`pub enum ${name} has no closing brace`);
  const body = source.slice(start + marker.length, end).split("\n");
  const names: string[] = [];
  let pendingRename: string | null = null;
  for (const rawLine of body) {
    const line = rawLine.trim();
    if (line === "" || line.startsWith("//")) continue;
    const rename = /^#\[serde\(rename = "([^"]+)"\)\]$/.exec(line);
    if (rename) {
      pendingRename = rename[1] as string;
      continue;
    }
    if (line.startsWith("#[")) continue;
    const variant = /^([A-Z][A-Za-z0-9]*),?$/.exec(line);
    if (!variant) {
      throw new Error(`pub enum ${name} has a non-unit variant this parser does not read: ${line}`);
    }
    const ident = variant[1] as string;
    names.push(pendingRename ?? ident.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase());
    pendingRename = null;
  }
  if (names.length === 0) throw new Error(`no variants parsed from pub enum ${name}`);
  return names;
}

/** Any repository file, read like the protocol sources (throws when absent). */
export function repoFile(relative: string): string {
  return read(relative);
}

export const PROJECT_LIFECYCLE_RUST = "core/crates/sandpane-service/src/project_lifecycle.rs";
export const CONFIRM_RUST = "core/crates/sandpane-service/src/confirm.rs";
export const VALIDATION_RUST = "core/crates/sandpane-core/src/validation.rs";
export const CONVERSATION_LIFECYCLE_RUST = "core/crates/sandpane-service/src/conversation_lifecycle.rs";
export const REDACT_RUST = "core/crates/sandpane-core/src/redact.rs";

/**
 * The value of `pub const NAME: &str = "…";` in `relative`, decoded as Rust
 * would: `\` + newline + leading whitespace is a line continuation, and `\"`,
 * `\\`, `\n`, `\t`, `\u{…}` are escapes. The literal is SCANNED (not cut at the
 * first `;`), because Core's messages contain semicolons.
 */
export function rustStrConst(relative: string, name: string): string {
  const source = read(relative);
  // A raw string literal (`r#"…"#`) has no escapes: its body is the value.
  const raw = new RegExp(`pub const ${name}: &str =\\s*r#"([\\s\\S]*?)"#;`).exec(source);
  if (raw !== null) return raw[1];
  const head = new RegExp(`pub const ${name}: &str =\\s*"`).exec(source);
  if (head === null) throw new Error(`${relative} has no "pub const ${name}: &str = \\"…\\";"`);
  let i = head.index + head[0].length;
  let out = "";
  for (;;) {
    const ch = source[i];
    if (ch === undefined) throw new Error(`unterminated string literal for ${name}`);
    if (ch === '"') return out;
    if (ch !== "\\") {
      out += ch;
      i += 1;
      continue;
    }
    const next = source[i + 1];
    if (next === "\n") {
      i += 2;
      while (source[i] === " " || source[i] === "\t" || source[i] === "\n") i += 1;
    } else if (next === "u" && source[i + 2] === "{") {
      const close = source.indexOf("}", i);
      out += String.fromCodePoint(parseInt(source.slice(i + 3, close), 16));
      i = close + 1;
    } else {
      out += next === "n" ? "\n" : next === "t" ? "\t" : (next ?? "");
      i += 2;
    }
  }
}

/** `pub const NAME: usize = N;` from any repo Rust file. */
export function rustUsizeConst(relative: string, name: string): number {
  const found = new RegExp(`pub const ${name}: usize = (\\d+);`).exec(read(relative));
  if (found?.[1] === undefined) throw new Error(`${relative} has no "pub const ${name}: usize = N;"`);
  return Number(found[1]);
}

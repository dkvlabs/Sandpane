#!/usr/bin/env python3
"""Schema <-> protocol-crate drift check (docs/specs/08 §6).

The Rust crate `core/crates/sandpane-protocol` is the source of truth and the
JSON Schemas in `schemas/` are hand-synced (schemas/README.md). This script
compares the exact WIRE VALUE SETS on both sides — methods, error codes,
agent event types, file change statuses, workspace modes, protocol version —
and fails on any mismatch so drift cannot hide. Field-level shapes
(additionalProperties etc.) are NOT compared (P1/P7 codegen territory).

Exit codes: 0 = in sync, 1 = drift found, 2 = the checker itself could not run
(missing file, unparseable input, or source shapes this checker cannot
classify — never report drift or misdirected fixes for a harness problem).

Usage: schema_drift.py [--repo-root DIR]   (default: repo root above scripts/)
"""

import json
import re
import sys
from pathlib import Path

RUST_WIRE = r'Self::\w+ => "([^"]+)"'

# The protocol crate is a single lib.rs today; a module split must update this
# path (that fails as exit 2 — "cannot read", not as fake drift).
RUST_SRC = Path("core/crates/sandpane-protocol/src/lib.rs")
SCHEMA_NAMES = [
    "rpc-request",
    "rpc-response",
    "agent-event",
    "task-event",
    "change-set",
    "sandbox-create-spec",
    "core-capabilities",
]


class HarnessError(Exception):
    """The checker cannot judge this input; never surfaced as drift."""


def snake(name: str) -> str:
    return re.sub(r"(?<!^)(?=[A-Z])", "_", name).lower()


def enum_body(src: str, name: str) -> str:
    m = re.search(rf"pub enum {name}\b[^{{]*\{{(.*?)\n\}}", src, re.DOTALL)
    if not m:
        raise HarnessError(f"enum {name} not found in protocol source")
    return m.group(1)


def unit_variants(body: str, name: str) -> set:
    """Unit enum variants (`    Created,`). Data-carrying variants raise —
    this checker models snake_case wire names of unit-only enums and must not
    silently drop a variant (its wire value would vanish from one side)."""
    out = set()
    for line in body.splitlines():
        if re.fullmatch(r"\s{4}([A-Z][A-Za-z0-9]*)\s*\{.*", line):
            raise HarnessError(
                f"{name} has a data-carrying variant ({line.strip()}); "
                "update the checker extraction before trusting this gate"
            )
        m = re.fullmatch(r"\s{4}([A-Z][A-Za-z0-9]*)\s*,", line)
        if m:
            out.add(m.group(1))
    return out


def dotted(s: str) -> bool:
    return bool(re.fullmatch(r"[a-z][a-z]*(\.[a-z][a-z]*)+", s))


def screaming(s: str) -> bool:
    return bool(re.fullmatch(r"[A-Z][A-Z_]*", s))


def parse_rust(src: str) -> dict:
    wire = re.findall(RUST_WIRE, src)
    methods = {v for v in wire if dotted(v)}
    codes = {v for v in wire if screaming(v)}
    # A wire string that is neither namespaced-dotted (specs/02 §2 method
    # convention) nor SCREAMING_SNAKE (error code convention) is unclassifiable
    # — refusing beats silently dropping it into neither set (that hid drift).
    unknown = [v for v in wire if not (dotted(v) or screaming(v))]
    if unknown:
        raise HarnessError(f"unclassifiable Rust wire strings: {sorted(unknown)}")

    # Variant-level serde renames sit at exactly 4-space depth; deeper ones
    # are field renames (requestId/providerType) and must not contaminate.
    agent_block = enum_body(src, "AgentEvent")
    agent_types = set(
        re.findall(r'^    #\[serde\(rename = "([a-z][a-z.]*)"\)\]', agent_block, re.MULTILINE)
    )
    change_statuses = {snake(v) for v in unit_variants(enum_body(src, "FileChangeStatus"), "FileChangeStatus")}
    ws_modes = {snake(v) for v in unit_variants(enum_body(src, "WorkspaceMode"), "WorkspaceMode")}

    m = re.search(r"pub const PROTOCOL_VERSION: u32 = (\d+)", src)
    if not m:
        raise HarnessError("PROTOCOL_VERSION constant not found in protocol source")
    return {
        "methods": methods,
        "codes": codes,
        "agent_types": agent_types,
        "change_statuses": change_statuses,
        "ws_modes": ws_modes,
        "protocol_version": int(m.group(1)),
    }


def parse_schemas(schemas: dict) -> dict:
    def need(path_fn, what):
        try:
            return path_fn()
        except (KeyError, TypeError, IndexError) as exc:
            raise HarnessError(f"cannot extract {what} from schemas: {exc!r}") from exc

    methods = need(lambda: set(schemas["rpc-request"]["properties"]["method"]["enum"]), "rpc-request method enum")
    response_codes = need(
        lambda: set(schemas["rpc-response"]["properties"]["err"]["properties"]["code"]["enum"]),
        "rpc-response error code enum",
    )
    branches = need(lambda: schemas["agent-event"]["oneOf"], "agent-event oneOf")
    agent_types = need(lambda: {b["properties"]["type"]["const"] for b in branches}, "agent-event type consts")
    event_codes = set()
    for branch in branches:
        if branch.get("properties", {}).get("type", {}).get("const") == "error":
            event_codes = need(lambda: set(branch["properties"]["code"]["enum"]), "agent-event error.code enum")
            break
    change_statuses = need(
        lambda: set(schemas["change-set"]["properties"]["changes"]["items"]["properties"]["status"]["enum"]),
        "change-set status enum",
    )
    ws_modes = need(
        lambda: set(schemas["sandbox-create-spec"]["properties"]["workspaceMode"]["enum"]),
        "sandbox-create-spec workspaceMode enum",
    )
    version = need(
        lambda: schemas["core-capabilities"]["properties"]["protocolVersion"]["const"],
        "core-capabilities protocolVersion const",
    )
    return {
        "methods": methods,
        "response_codes": response_codes,
        "agent_types": agent_types,
        "event_codes": event_codes,
        "change_statuses": change_statuses,
        "ws_modes": ws_modes,
        "protocol_version": version,
    }


def main(repo_root: Path) -> int:
    try:
        src = (repo_root / RUST_SRC).read_text(encoding="utf-8")
    except OSError as exc:
        print(f"checker cannot read protocol source: {exc}", file=sys.stderr)
        return 2
    try:
        schemas = {
            n: json.loads((repo_root / "schemas" / f"{n}.schema.json").read_text(encoding="utf-8"))
            for n in SCHEMA_NAMES
        }
    except (OSError, json.JSONDecodeError) as exc:
        print(f"checker cannot read schemas: {exc}", file=sys.stderr)
        return 2

    try:
        rust = parse_rust(src)
        sch = parse_schemas(schemas)
    except HarnessError as exc:
        print(f"checker cannot classify input (not drift): {exc}", file=sys.stderr)
        return 2

    checks = [
        ("methods (rpc-request.method)", rust["methods"], sch["methods"]),
        ("error codes (rpc-response.err.code)", rust["codes"], sch["response_codes"]),
        ("error codes (agent-event error.code)", rust["codes"], sch["event_codes"]),
        ("agent event types (agent-event oneOf)", rust["agent_types"], sch["agent_types"]),
        ("file change statuses (change-set)", rust["change_statuses"], sch["change_statuses"]),
        ("workspace modes (sandbox-create-spec)", rust["ws_modes"], sch["ws_modes"]),
    ]

    drifted = False
    for name, r, s in checks:
        if r == s:
            print(f"OK   {name}: {len(r)} values match")
        else:
            drifted = True
            print(f"DRIFT {name}")
            print(f"  only in Rust:   {sorted(r - s)}")
            print(f"  only in Schema: {sorted(s - r)}")

    if rust["protocol_version"] == sch["protocol_version"]:
        print(f"OK   protocol version: {rust['protocol_version']}")
    else:
        drifted = True
        print(
            f"DRIFT protocol version: Rust {rust['protocol_version']} "
            f"vs schema {sch['protocol_version']}"
        )

    if drifted:
        print(
            "\nFix: update schemas/ to match the Rust crate (source of truth per schemas/README.md), "
            "or land a coordinated protocol-version bump per docs/specs/02 §2.",
            file=sys.stderr,
        )
        return 1
    print("\nAll schema/protocol value sets in sync.")
    return 0


if __name__ == "__main__":
    args = sys.argv[1:]
    root = Path(args[1]) if args[:1] == ["--repo-root"] and len(args) > 1 else Path(__file__).resolve().parent.parent
    sys.exit(main(root))

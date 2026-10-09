# Sandpane protocol schemas

Versioned JSON Schemas for the Sandpane Core IPC protocol and durable events
(docs/specs/02_ARCHITECTURE_AND_DATA.md §2-§4). These are **Sandpane-owned**
formats — never Docker SBX / Codex / Claude wire formats.

| Schema | Describes | Rust source of truth |
|---|---|---|
| [rpc-request.schema.json](rpc-request.schema.json) | client → core frame | `sandpane_protocol::RpcRequest` |
| [rpc-response.schema.json](rpc-response.schema.json) | core → client frame (ok/err, error codes) | `sandpane_protocol::RpcResponse` |
| [core-capabilities.schema.json](core-capabilities.schema.json) | `system.probe` result | `sandpane_protocol::CoreCapabilities` |
| [agent-event.schema.json](agent-event.schema.json) | normalized agent event union | `sandpane_protocol::AgentEvent` |
| [task-event.schema.json](task-event.schema.json) | durable replayable log entry | `sandpane_protocol::TaskEvent` |
| [sandbox-create-spec.schema.json](sandbox-create-spec.schema.json) | `sandbox.create` params | `sandpane_protocol::SandboxCreateSpec` |
| [change-set.schema.json](change-set.schema.json) | `git.review` result | `sandpane_protocol::ChangeSet` |

## Sync status

**Hand-synced** with the Rust types at scaffold stage — the Rust crate is the
source of truth. A generated-binding + drift-check pipeline (schemas →
TypeScript/Kotlin codegen, CI diff gate) is a P1/P7 deliverable
(docs/specs/07 P1 "Stable schema + generated bindings + drift check",
docs/specs/08 §6 "schema/codegen drift"). Until it lands, any protocol change
must update the Rust types AND these files in the same commit, and say so in
the changelog entry.

//! Sandpane Core domain logic.
//!
//! Safety model (docs/specs/06): every external string passes [`validation`]
//! before it can reach a subprocess argument vector; subprocesses are spawned
//! with fixed executables + argument arrays only — never through a shell.

pub mod apply;
pub mod db;
pub mod diff;
pub mod events;
pub mod git;
pub mod idempotency;
pub mod objects;
pub mod process;
pub mod redact;
pub mod sbx;
pub mod scheduler;
pub mod task;
pub mod validation;
pub mod workspace;

pub use db::{Database, DbError};
pub use events::EventLog;
pub use task::{TaskStateError, TaskStateMachine};
pub use validation::{ValidationError, Validator};

//! A3b — conversation lifecycle (design of record
//! `docs/plans/2026-10-09-protocol-v1-additions.md` §3.3).
//!
//! `conversation.rename`, `conversation.archive` / `conversation.unarchive`,
//! `conversation.delete` (two-step confirmation token bound to the
//! conversation ID), `conversation.export` (redacted, paged, bounded), the
//! single `Conversation` wire shape every method returns, and the shared
//! "sendable conversation" check both `conversation.send` paths use. Nothing
//! here touches host files, worktrees, branches or sbx sandboxes: every
//! effect is a row in Core's own database.
//!
//! LOCK ORDER (same as A3a): the DB mutex is never held while the
//! confirmation store is locked, while a worktree path is stat'ed, or while
//! redaction runs. Every guard below is a named binding in its own block —
//! never a temporary in an `if let` / `match` / `while let` scrutinee whose
//! body could re-lock (A3a review C1).
//!
//! CHECK ORDER when both the conversation and its project are archived: the
//! PROJECT refusal comes first — in an archived project `conversation.unarchive`
//! is itself refused, so unarchiving the project is the only actionable step.

use std::path::Path;

use rusqlite::{params, Connection, OptionalExtension};
use sandpane_core::redact::{self, RedactionCounts};
use sandpane_core::task::TaskStateMachine;
use sandpane_core::validation::Validator;
use sandpane_protocol::{
    ConfirmationRequest, ConfirmationTarget, Conversation, ConversationDeleteParams,
    ConversationDeleteResult, ConversationExportParams, ConversationExportResult,
    ConversationIdParams, ConversationRenameParams, ErrorCode, ExportRedaction,
    CONVERSATION_EXPORT_FORMAT,
};

use crate::{
    clamp_limit, confirm, internal, now_rfc3339, project_lifecycle, read_message_page,
    rfc3339_from_unix, task_status_from_stored, validate_scoping_id, ServerInner, SvcError,
    SvcFailure,
};

pub const CONVERSATION_DELETE_ACTION: &str = "conversation.delete";

// §3.3 item 8 — exact user-facing messages; clients match on them.
pub const MSG_CONVERSATION_ARCHIVED: &str =
    "conversation is archived; unarchive it first; nothing was changed";
pub const MSG_CONVERSATION_HAS_TASKS: &str = "conversation has tasks that are not finished; \
     cancel or finish them first; nothing was deleted";
pub const MSG_CONVERSATION_NOT_FOUND: &str = "conversation not found";

// Not in §3.3 item 8 (no client matches on it), fixed here for the report.
pub const MSG_TITLE_BLANK: &str =
    "conversation title must not be empty or whitespace-only; nothing was changed";

/// The title `conversation.create` stores when none (or only whitespace) is
/// given.
pub const UNTITLED_CONVERSATION: &str = "Untitled conversation";

const CONVERSATION_COLUMNS: &str =
    "id, project_id, title, agent_id, created_at, archived_at, sandbox_id";

fn not_found() -> SvcError {
    (ErrorCode::NotFound, MSG_CONVERSATION_NOT_FOUND.to_string())
}

/// Map one row selected with [`CONVERSATION_COLUMNS`] (in that order).
pub(crate) fn conversation_from_row(r: &rusqlite::Row<'_>) -> rusqlite::Result<Conversation> {
    Ok(Conversation {
        id: r.get(0)?,
        project_id: r.get(1)?,
        title: r.get(2)?,
        agent_id: r.get(3)?,
        created_at: r.get(4)?,
        archived_at: r.get(5)?,
        sandbox_id: r.get(6)?,
    })
}

/// The single `Conversation` wire shape (`archivedAt` / `sandboxId` only when
/// set), or `None` when the row does not exist.
pub(crate) fn find_conversation(
    conn: &Connection,
    id: &str,
) -> Result<Option<Conversation>, SvcError> {
    conn.query_row(
        &format!("SELECT {CONVERSATION_COLUMNS} FROM conversations WHERE id = ?1"),
        params![id],
        conversation_from_row,
    )
    .optional()
    .map_err(internal)
}

pub(crate) fn load_conversation(conn: &Connection, id: &str) -> Result<Conversation, SvcError> {
    find_conversation(conn, id)?.ok_or_else(not_found)
}

/// `conversation.list` (A3b `includeArchived`): live conversations only
/// unless asked, ordered as before (creation time, then id).
pub(crate) fn list_conversations(
    conn: &Connection,
    project_id: Option<&str>,
    include_archived: bool,
    limit: i64,
) -> Result<Vec<Conversation>, SvcError> {
    let mut stmt = conn
        .prepare(&format!(
            "SELECT {CONVERSATION_COLUMNS} FROM conversations
             WHERE (?3 OR archived_at IS NULL) AND (?1 IS NULL OR project_id = ?1)
             ORDER BY created_at ASC, id ASC LIMIT ?2"
        ))
        .map_err(internal)?;
    let rows = stmt
        .query_map(
            params![project_id, limit, include_archived],
            conversation_from_row,
        )
        .map_err(internal)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(internal)?;
    Ok(rows)
}

/// A conversation that may be written to (sent to, renamed): it exists, its
/// project is not archived (A3a message — checked FIRST, see the module
/// docs), and it is not archived itself (§3.3 item 4). Returns its project
/// id. Callers run it under the DB mutex in the same critical section as the
/// write it guards: `conversation.send` calls it twice — the early check
/// before any worktree is allocated, and the AUTHORITATIVE re-check inside the
/// task write transaction.
pub(crate) fn require_writable_conversation(
    conn: &Connection,
    id: &str,
) -> Result<String, SvcError> {
    let conv = load_conversation(conn, id)?;
    project_lifecycle::require_live_project(conn, &conv.project_id)?;
    if conv.archived_at.is_some() {
        return Err((
            ErrorCode::ValidationFailed,
            MSG_CONVERSATION_ARCHIVED.to_string(),
        ));
    }
    Ok(conv.project_id)
}

/// The title `conversation.create` stores (§3.3 item 7): empty or
/// whitespace-only becomes [`UNTITLED_CONVERSATION`]; anything else must
/// pass `Validator::conversation_title`.
pub(crate) fn title_for_create(title: &str) -> Result<String, SvcError> {
    if title.trim().is_empty() {
        return Ok(UNTITLED_CONVERSATION.to_string());
    }
    Validator::conversation_title(title)
        .map(str::to_string)
        .map_err(|e| (ErrorCode::ValidationFailed, format!("title: {e}")))
}

// ---------------------------------------------------------------------------
// conversation.rename / archive / unarchive
// ---------------------------------------------------------------------------

pub(crate) fn conversation_rename(
    inner: &ServerInner,
    p: ConversationRenameParams,
) -> Result<serde_json::Value, SvcError> {
    validate_scoping_id("conversationId", &p.conversation_id)?;
    if p.title.trim().is_empty() {
        return Err((ErrorCode::ValidationFailed, MSG_TITLE_BLANK.to_string()));
    }
    Validator::conversation_title(&p.title)
        .map_err(|e| (ErrorCode::ValidationFailed, format!("title: {e}")))?;
    let db = inner.lock_db();
    let tx = db.conn().unchecked_transaction().map_err(internal)?;
    require_writable_conversation(&tx, &p.conversation_id)?;
    tx.execute(
        "UPDATE conversations SET title = ?2 WHERE id = ?1",
        params![p.conversation_id, p.title],
    )
    .map_err(internal)?;
    let conv = load_conversation(&tx, &p.conversation_id)?;
    tx.commit().map_err(internal)?;
    serde_json::to_value(conv).map_err(internal)
}

/// `conversation.archive` / `conversation.unarchive`. Idempotent: an
/// already-archived conversation keeps its ORIGINAL `archivedAt`. Archive is
/// allowed in an archived project; unarchive is not (A3a message).
pub(crate) fn conversation_set_archived(
    inner: &ServerInner,
    p: ConversationIdParams,
    archive: bool,
) -> Result<serde_json::Value, SvcError> {
    validate_scoping_id("conversationId", &p.conversation_id)?;
    let db = inner.lock_db();
    let tx = db.conn().unchecked_transaction().map_err(internal)?;
    let conv = load_conversation(&tx, &p.conversation_id)?;
    if !archive {
        project_lifecycle::require_live_project(&tx, &conv.project_id)?;
    }
    match (archive, conv.archived_at.is_some()) {
        (true, false) => {
            tx.execute(
                "UPDATE conversations SET archived_at = ?2 WHERE id = ?1",
                params![p.conversation_id, now_rfc3339()],
            )
            .map_err(internal)?;
        }
        (false, true) => {
            tx.execute(
                "UPDATE conversations SET archived_at = NULL WHERE id = ?1",
                params![p.conversation_id],
            )
            .map_err(internal)?;
        }
        _ => {}
    }
    let conv = load_conversation(&tx, &p.conversation_id)?;
    tx.commit().map_err(internal)?;
    serde_json::to_value(conv).map_err(internal)
}

// ---------------------------------------------------------------------------
// conversation.delete (§2 token flow + §3.3 item 5)
// ---------------------------------------------------------------------------

pub(crate) fn conversation_delete(
    inner: &ServerInner,
    p: ConversationDeleteParams,
) -> Result<serde_json::Value, SvcFailure> {
    validate_scoping_id("conversationId", &p.conversation_id)?;
    let result = match p.confirm_token {
        None => ConversationDeleteResult {
            confirmation: Some(issue_delete_confirmation(inner, &p.conversation_id)?),
            deleted: None,
        },
        Some(token) => {
            delete_confirmed(inner, &p.conversation_id, &token)?;
            ConversationDeleteResult {
                confirmation: None,
                deleted: Some(true),
            }
        }
    };
    serde_json::to_value(result).map_err(|e| internal(e).into())
}

/// The §3.3 item 5 precondition: any non-terminal task of the conversation
/// blocks the delete. FAIL CLOSED: a stored status Core cannot read counts as
/// not finished (`awaiting_review` is not terminal either).
fn has_unfinished_tasks(conn: &Connection, id: &str) -> Result<bool, SvcError> {
    let mut stmt = conn
        .prepare("SELECT id, status FROM tasks WHERE conversation_id = ?1")
        .map_err(internal)?;
    let statuses = stmt
        .query_map(params![id], |r| {
            Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))
        })
        .map_err(internal)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(internal)?;
    Ok(statuses.iter().any(|(task_id, stored)| {
        task_status_from_stored(stored, task_id)
            .map(|s| !TaskStateMachine::from_status(s).is_terminal())
            .unwrap_or(true)
    }))
}

/// A7 (§3.7 item 5, W7): refuse while a verification runs for any task of
/// the conversation. Called under the DB mutex (the registry is a leaf).
fn refuse_running_verification(inner: &ServerInner, id: &str) -> Result<(), SvcFailure> {
    if inner.verifications.running_for_conversation(id) {
        return Err(SvcFailure::from((
            ErrorCode::Conflict,
            crate::MSG_CONVERSATION_VERIFICATION_RUNNING.to_string(),
        )));
    }
    Ok(())
}

fn conflict_has_tasks() -> SvcFailure {
    SvcFailure::from((ErrorCode::Conflict, MSG_CONVERSATION_HAS_TASKS.to_string()))
}

fn count(conn: &Connection, sql: &str, id: &str) -> Result<i64, SvcError> {
    conn.query_row(sql, params![id], |r| r.get(0))
        .map_err(internal)
}

fn plural(n: i64, one: &str, many: &str) -> String {
    format!("{n} {}", if n == 1 { one } else { many })
}

/// What the delete dialog reports, read under the DB mutex. Worktree paths
/// are only COLLECTED here; whether each still exists on disk is checked
/// after the mutex is released (A3a review I6).
struct DeleteImpact {
    title: String,
    sandbox_id: Option<String>,
    messages: i64,
    tasks: i64,
    branches: i64,
    worktree_paths: Vec<String>,
}

fn delete_impact(conn: &Connection, conv: Conversation) -> Result<DeleteImpact, SvcError> {
    let id = conv.id.as_str();
    let messages = count(
        conn,
        "SELECT COUNT(*) FROM messages WHERE conversation_id = ?1",
        id,
    )?;
    let tasks = count(
        conn,
        "SELECT COUNT(*) FROM tasks WHERE conversation_id = ?1",
        id,
    )?;
    let branches = count(
        conn,
        "SELECT COUNT(DISTINCT task_branch) FROM tasks
         WHERE task_branch IS NOT NULL AND conversation_id = ?1",
        id,
    )?;
    let worktree_paths = {
        let mut stmt = conn
            .prepare(
                "SELECT worktree_path FROM tasks
                 WHERE worktree_path IS NOT NULL AND worktree_removed_at IS NULL
                   AND conversation_id = ?1",
            )
            .map_err(internal)?;
        let paths = stmt
            .query_map(params![id], |r| r.get::<_, String>(0))
            .map_err(internal)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(internal)?;
        paths
    };
    Ok(DeleteImpact {
        title: conv.title,
        sandbox_id: conv.sandbox_id,
        messages,
        tasks,
        branches,
        worktree_paths,
    })
}

/// Render [`DeleteImpact`]; called with NO Core lock held (it stats each
/// worktree path — a stat, never a git call or a delete). Counts only, never
/// content. Line 0 carries the stored title, which may predate the A3b title
/// rule: clients reveal and cap every Core string.
fn impact_lines(i: &DeleteImpact) -> Vec<String> {
    let worktrees = i
        .worktree_paths
        .iter()
        .filter(|p| Path::new(p).is_dir())
        .count() as i64;
    vec![
        format!(
            "deletes conversation {} and all of its Core records; this cannot be undone",
            i.title
        ),
        format!(
            "{} and {} are deleted, with their task events, artifacts and verification records",
            plural(i.messages, "message", "messages"),
            plural(i.tasks, "task", "tasks"),
        ),
        format!(
            "{} and {} in host repositories are left in place; Core never touches host files, \
             worktrees or branches",
            plural(
                worktrees,
                "Core-allocated worktree directory",
                "Core-allocated worktree directories"
            ),
            plural(i.branches, "task branch", "task branches"),
        ),
        match &i.sandbox_id {
            Some(name) => format!("the sandbox chosen at creation ({name}) is not touched"),
            None => "no sandbox was chosen at creation; no sandbox is touched".to_string(),
        },
    ]
}

/// Step 1: check the precondition, describe the impact, issue a token bound
/// to `(conversation.delete, conversation id)`. Changes nothing.
fn issue_delete_confirmation(
    inner: &ServerInner,
    id: &str,
) -> Result<ConfirmationRequest, SvcFailure> {
    let impact = {
        let db = inner.lock_db();
        let conv = load_conversation(db.conn(), id)?;
        refuse_running_verification(inner, id)?;
        if has_unfinished_tasks(db.conn(), id)? {
            return Err(conflict_has_tasks());
        }
        delete_impact(db.conn(), conv)?
    };
    // DB mutex released: now stat the worktree paths.
    let lines = impact_lines(&impact);
    // ...and only now lock the confirmation store.
    let ttl = inner.confirmation_ttl;
    let token = inner
        .lock_confirmations()
        .issue(
            confirm::ConfirmationBinding {
                action: CONVERSATION_DELETE_ACTION.to_string(),
                // Display only: `consume_by_id` never compares it, so a
                // rename between the steps does not invalidate the token.
                name: impact.title.clone(),
                id: id.to_string(),
            },
            std::time::Instant::now(),
            ttl,
        )
        .map_err(|e| {
            SvcFailure::from((
                ErrorCode::Internal,
                format!("OS random source unavailable for a confirmation token: {e}"),
            ))
        })?;
    let expires_unix = (std::time::SystemTime::now() + ttl)
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    Ok(ConfirmationRequest {
        token,
        expires_at: rfc3339_from_unix(expires_unix),
        action: CONVERSATION_DELETE_ACTION.to_string(),
        target: ConfirmationTarget {
            name: impact.title,
            id: id.to_string(),
        },
        impact: lines,
        // A conversation exists only in Core: nothing external to vouch for.
        external: false,
    })
}

/// Step 2: consume the token FIRST (every attempt burns it), then — under the
/// DB mutex, in ONE transaction — re-check existence and the precondition and
/// delete in the explicit §3.3 item 5 order. `ON DELETE CASCADE` is only a
/// backstop. A concurrent `conversation.send` either committed first (this
/// re-check then sees its non-terminal task) or finds the conversation gone
/// in its own transaction (NOT_FOUND). Host files, worktrees, branches,
/// sandboxes and idempotency rows are never touched.
fn delete_confirmed(inner: &ServerInner, id: &str, token: &str) -> Result<(), SvcFailure> {
    inner
        .lock_confirmations()
        .consume_by_id(
            token,
            CONVERSATION_DELETE_ACTION,
            id,
            std::time::Instant::now(),
        )
        .map_err(|confirm::TokenRejected| {
            SvcFailure::from((
                ErrorCode::ValidationFailed,
                confirm::TOKEN_REJECTED_MESSAGE.to_string(),
            ))
        })?;
    let db = inner.lock_db();
    let tx = db.conn().unchecked_transaction().map_err(internal)?;
    if find_conversation(&tx, id)?.is_none() {
        return Err(not_found().into());
    }
    refuse_running_verification(inner, id)?;
    if has_unfinished_tasks(&tx, id)? {
        return Err(conflict_has_tasks());
    }
    const TASKS: &str = "(SELECT id FROM tasks WHERE conversation_id = ?1)";
    for sql in [
        // 1. what hangs off the conversation's tasks (A7: verification
        //    runs before tasks)
        format!("DELETE FROM verification_runs WHERE task_id IN {TASKS}"),
        format!("DELETE FROM verifications WHERE task_id IN {TASKS}"),
        format!("DELETE FROM task_artifacts WHERE task_id IN {TASKS}"),
        format!("DELETE FROM task_events WHERE task_id IN {TASKS}"),
        // 2. the tasks
        "DELETE FROM tasks WHERE conversation_id = ?1".to_string(),
        // 3. agent sessions
        "DELETE FROM agent_sessions WHERE conversation_id = ?1".to_string(),
        // 4. messages
        "DELETE FROM messages WHERE conversation_id = ?1".to_string(),
        // 5. client selections naming it (no foreign key: cleared, not
        //    cascaded; the client_state row itself stays)
        "UPDATE client_state SET selected_conversation = NULL
         WHERE selected_conversation = ?1"
            .to_string(),
        // 6. the conversation
        "DELETE FROM conversations WHERE id = ?1".to_string(),
    ] {
        tx.execute(&sql, params![id]).map_err(internal)?;
    }
    tx.commit().map_err(internal)?;
    Ok(())
}

// ---------------------------------------------------------------------------
// conversation.export (§3.3 item 6)
// ---------------------------------------------------------------------------

/// One redacted export page. Paging and bounds are `conversation.history`'s
/// own ([`read_message_page`]): the byte ceiling is counted over the RAW
/// rows under the DB lock; redaction — which never lengthens text — runs
/// after the lock is released. Archived conversations are exportable. The
/// title is redacted on every page; its replacements count only on the first
/// page (`afterSequence` absent or 0), so pages can be summed.
pub(crate) fn conversation_export(
    inner: &ServerInner,
    p: ConversationExportParams,
) -> Result<serde_json::Value, SvcError> {
    let limit = clamp_limit(p.limit);
    validate_scoping_id("conversationId", &p.conversation_id)?;
    let after = p.after_sequence.max(0);
    let (mut conversation, mut page) = {
        let db = inner.lock_db();
        let conversation = load_conversation(db.conn(), &p.conversation_id)?;
        let page = read_message_page(db.conn(), &p.conversation_id, after, limit)?;
        (conversation, page)
    };
    // DB mutex released: redaction never runs under it.
    if let Some(hook) = &inner.test_before_export_redaction {
        (hook.0)(inner);
    }
    let unavailable = |e: redact::RedactorUnavailable| {
        (
            ErrorCode::Internal,
            format!("{e}; nothing was exported (Core never exports unredacted text)"),
        )
    };
    let mut counts = RedactionCounts::default();
    // The title is redacted on EVERY page but its replacements are COUNTED
    // only on the first page (`afterSequence` absent, 0 or negative), so a
    // client summing `replacements` / `byKind` over all pages counts the
    // title once (coordinator decision, frozen for clients).
    let mut title_counts = RedactionCounts::default();
    conversation.title =
        redact::redact(&conversation.title, &mut title_counts).map_err(unavailable)?;
    if after == 0 {
        counts = title_counts;
    }
    for m in &mut page.messages {
        m.content = redact::redact(&m.content, &mut counts).map_err(unavailable)?;
    }
    let result = ConversationExportResult {
        format: CONVERSATION_EXPORT_FORMAT.to_string(),
        exported_at: now_rfc3339(),
        conversation,
        messages: page.messages,
        truncated: page.truncated,
        next_sequence: page.next_sequence,
        redaction: ExportRedaction {
            best_effort: true,
            replacements: counts.total(),
            by_kind: counts
                .by_kind()
                .iter()
                .map(|(k, n)| (k.to_string(), *n))
                .collect(),
        },
    };
    serde_json::to_value(result).map_err(internal)
}

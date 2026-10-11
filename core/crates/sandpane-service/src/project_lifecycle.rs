//! A3a — project lifecycle (design of record
//! `docs/plans/2026-10-09-protocol-v1-additions.md` §3.2).
//!
//! `project.update`, `project.archive` / `project.unarchive`,
//! `project.delete` (two-step confirmation token bound to the project ID),
//! `project.add_repository`, `project.remove_repository`, and the shared
//! "live project" check other methods use to refuse work on an archived
//! project. Nothing here touches host files, branches or sbx sandboxes: every
//! effect is a row in Core's own database.
//!
//! LOCK ORDER (documented once, for every path here): the DB mutex may be
//! held while reading the per-project in-flight create count
//! ([`crate::inflight::ProjectCreates`], a leaf lock); the confirmation store
//! is locked only AFTER the DB mutex is released (as `sandbox.remove` does);
//! git subprocesses (`canonical_repository`) run with no Core lock held.

use std::path::Path;

use rusqlite::{params, Connection, OptionalExtension};
use sandpane_core::task::TaskStateMachine;
use sandpane_core::validation::Validator;
use sandpane_protocol::{
    ConfirmationRequest, ConfirmationTarget, ErrorCode, Project, ProjectDeleteParams,
    ProjectDeleteResult, ProjectIdParams, ProjectListParams, ProjectRepositoryParams,
    ProjectUpdateParams,
};

use crate::{
    canonical_repository, confirm, internal, now_rfc3339, project_repository_paths,
    revet_excludes_for_new_repositories, rfc3339_from_unix, runtime, task_status_from_stored,
    ServerInner, SvcError, SvcFailure,
};

pub const PROJECT_DELETE_ACTION: &str = "project.delete";

// §3.2 item 8 — exact user-facing messages; clients match on them.
pub const MSG_PROJECT_ARCHIVED: &str =
    "project is archived; unarchive it first; nothing was changed";
pub const MSG_PROJECT_HAS_TASKS: &str =
    "project has tasks that are not finished; cancel or finish them first; nothing was deleted";
pub const MSG_PROJECT_HAS_SANDBOXES: &str =
    "project has sandboxes; remove them first; nothing was deleted";
pub const MSG_REPOSITORY_IN_USE: &str =
    "repository is used by a task or sandbox of this project; nothing was removed";
pub const MSG_PROJECT_CREATE_IN_FLIGHT: &str =
    "a sandbox is being created for this project; try again when it finishes; nothing was deleted";
/// Review W1(c): `project.remove_repository` while a create is in flight.
pub const MSG_REPOSITORY_REMOVE_WHILE_CREATING: &str =
    "a sandbox is being created for this project; try again when it finishes; nothing was removed";
/// Review W1(b): the create's post-claim re-check found its mounted
/// repository unregistered meanwhile (CONFLICT; nothing ran, key released).
pub const MSG_REPOSITORY_UNREGISTERED_DURING_CREATE: &str = "the repository was unregistered from \
     this project while the sandbox was being prepared; nothing was run";

// Not in §3.2 item 8 (no client matches on them), fixed here for the report.
pub const MSG_PROJECT_NOT_FOUND: &str = "project not found";
pub const MSG_REPOSITORY_NOT_REGISTERED: &str =
    "repository is not registered with this project; nothing was removed";
pub const MSG_UPDATE_NEEDS_A_FIELD: &str =
    "project.update needs name or description; nothing was changed";

/// The stored row of one project.
struct ProjectRow {
    name: String,
    description: String,
    created_at: String,
    archived_at: Option<String>,
}

fn project_row(conn: &Connection, id: &str) -> Result<Option<ProjectRow>, SvcError> {
    conn.query_row(
        "SELECT name, description, created_at, archived_at FROM projects WHERE id = ?1",
        params![id],
        |r| {
            Ok(ProjectRow {
                name: r.get(0)?,
                description: r.get(1)?,
                created_at: r.get(2)?,
                archived_at: r.get(3)?,
            })
        },
    )
    .optional()
    .map_err(internal)
}

fn not_found() -> SvcError {
    (ErrorCode::NotFound, MSG_PROJECT_NOT_FOUND.to_string())
}

/// The single `Project` wire shape every A3a method returns (and
/// `project.list` builds the same way): stored fields, registered
/// repositories in registration order, `archivedAt` only when archived.
pub(crate) fn load_project(conn: &Connection, id: &str) -> Result<Project, SvcError> {
    let row = project_row(conn, id)?.ok_or_else(not_found)?;
    let mut stmt = conn
        .prepare("SELECT canonical_path FROM repositories WHERE project_id = ?1 ORDER BY rowid")
        .map_err(internal)?;
    let repositories = stmt
        .query_map(params![id], |r| r.get::<_, String>(0))
        .map_err(internal)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(internal)?;
    Ok(Project {
        id: id.to_string(),
        name: row.name,
        description: row.description,
        created_at: row.created_at,
        repositories,
        archived_at: row.archived_at,
    })
}

/// The project exists and is NOT archived (§3.2 item 3), else
/// `NOT_FOUND` / `VALIDATION_FAILED` with the exact archived message.
/// Callers run it under the DB mutex, in the same critical section as the
/// write it guards, so it cannot race `project.archive`.
pub(crate) fn require_live_project(conn: &Connection, id: &str) -> Result<(), SvcError> {
    match project_row(conn, id)? {
        None => Err(not_found()),
        Some(r) if r.archived_at.is_some() => Err((
            ErrorCode::ValidationFailed,
            MSG_PROJECT_ARCHIVED.to_string(),
        )),
        Some(_) => Ok(()),
    }
}

/// `sandbox.create`'s post-claim re-check (§3.2 item 4, review W1(b)), run
/// under the DB mutex AFTER the in-flight guard is taken: the project still
/// exists and is not archived, and the repository the create will mount (if
/// any) is still registered to it. `project.remove_repository` reads the
/// in-flight count under the same mutex, so either it refuses or this
/// re-check sees the repository gone — never a mount of an unregistered
/// repository.
pub(crate) fn recheck_create_target(
    conn: &Connection,
    project_id: &str,
    mount_repo_id: Option<&str>,
) -> Result<(), SvcError> {
    require_live_project(conn, project_id)?;
    if let Some(repo_id) = mount_repo_id {
        let registered: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM repositories WHERE id = ?1 AND project_id = ?2",
                params![repo_id, project_id],
                |r| r.get(0),
            )
            .map_err(internal)?;
        if registered == 0 {
            return Err((
                ErrorCode::Conflict,
                MSG_REPOSITORY_UNREGISTERED_DURING_CREATE.to_string(),
            ));
        }
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// project.list / project.update / archive / unarchive
// ---------------------------------------------------------------------------

/// `project.list`: live projects only unless `includeArchived: true`.
/// Two prepared statements (rows, then every repository path grouped in
/// Rust) rather than one query per project — the reviewed pre-A3a design.
/// Each row is built with exactly the fields [`load_project`] returns.
pub(crate) fn project_list(
    inner: &ServerInner,
    params: serde_json::Value,
) -> Result<serde_json::Value, SvcError> {
    let p = ProjectListParams::from_wire(params)
        .map_err(|e| (ErrorCode::ValidationFailed, format!("invalid params: {e}")))?;
    let db = inner.lock_db();
    let mut repos = project_repository_paths(&db)?;
    let mut stmt = db
        .conn()
        .prepare(
            "SELECT id, name, description, created_at, archived_at FROM projects
             WHERE (?1 OR archived_at IS NULL) ORDER BY created_at",
        )
        .map_err(internal)?;
    let projects = stmt
        .query_map(params![p.include_archived()], |r| {
            Ok(Project {
                id: r.get(0)?,
                name: r.get(1)?,
                description: r.get(2)?,
                created_at: r.get(3)?,
                archived_at: r.get(4)?,
                repositories: Vec::new(),
            })
        })
        .map_err(internal)?
        .map(|row| {
            row.map(|mut project| {
                project.repositories = repos.remove(&project.id).unwrap_or_default();
                project
            })
        })
        .collect::<Result<Vec<_>, _>>()
        .map_err(internal)?;
    serde_json::to_value(projects).map_err(internal)
}

pub(crate) fn project_update(
    inner: &ServerInner,
    p: ProjectUpdateParams,
) -> Result<serde_json::Value, SvcError> {
    if p.name.is_none() && p.description.is_none() {
        return Err((
            ErrorCode::ValidationFailed,
            MSG_UPDATE_NEEDS_A_FIELD.to_string(),
        ));
    }
    if let Some(name) = &p.name {
        Validator::project_name(name)
            .map_err(|e| (ErrorCode::ValidationFailed, format!("project name: {e}")))?;
    }
    if let Some(d) = &p.description {
        Validator::project_description(d).map_err(|e| {
            (
                ErrorCode::ValidationFailed,
                format!("project description: {e}"),
            )
        })?;
    }
    let db = inner.lock_db();
    let tx = db.conn().unchecked_transaction().map_err(internal)?;
    require_live_project(&tx, &p.project_id)?;
    if let Some(name) = &p.name {
        tx.execute(
            "UPDATE projects SET name = ?2 WHERE id = ?1",
            params![p.project_id, name],
        )
        .map_err(internal)?;
    }
    if let Some(d) = &p.description {
        tx.execute(
            "UPDATE projects SET description = ?2 WHERE id = ?1",
            params![p.project_id, d],
        )
        .map_err(internal)?;
    }
    let project = load_project(&tx, &p.project_id)?;
    tx.commit().map_err(internal)?;
    serde_json::to_value(project).map_err(internal)
}

/// `project.archive` / `project.unarchive`. Idempotent: an already-archived
/// project keeps its ORIGINAL `archivedAt` (never re-stamped).
pub(crate) fn project_set_archived(
    inner: &ServerInner,
    p: ProjectIdParams,
    archive: bool,
) -> Result<serde_json::Value, SvcError> {
    let db = inner.lock_db();
    let tx = db.conn().unchecked_transaction().map_err(internal)?;
    let row = project_row(&tx, &p.project_id)?.ok_or_else(not_found)?;
    match (archive, row.archived_at.is_some()) {
        (true, false) => {
            tx.execute(
                "UPDATE projects SET archived_at = ?2 WHERE id = ?1",
                params![p.project_id, now_rfc3339()],
            )
            .map_err(internal)?;
        }
        (false, true) => {
            tx.execute(
                "UPDATE projects SET archived_at = NULL WHERE id = ?1",
                params![p.project_id],
            )
            .map_err(internal)?;
        }
        _ => {}
    }
    let project = load_project(&tx, &p.project_id)?;
    tx.commit().map_err(internal)?;
    serde_json::to_value(project).map_err(internal)
}

// ---------------------------------------------------------------------------
// project.delete (§2 token flow + §3.2 items 4-5)
// ---------------------------------------------------------------------------

pub(crate) fn project_delete(
    inner: &ServerInner,
    p: ProjectDeleteParams,
) -> Result<serde_json::Value, SvcFailure> {
    let result = match p.confirm_token {
        None => ProjectDeleteResult {
            confirmation: Some(issue_delete_confirmation(inner, &p.project_id)?),
            deleted: None,
        },
        Some(token) => {
            delete_confirmed(inner, &p.project_id, &token)?;
            ProjectDeleteResult {
                confirmation: None,
                deleted: Some(true),
            }
        }
    };
    serde_json::to_value(result).map_err(|e| internal(e).into())
}

/// The first precondition that blocks deleting `id` (§3.2 item 4), or
/// `None`. Checked under the DB mutex — at step 2 inside the delete
/// transaction — and reads the in-flight create count (a leaf lock).
fn delete_blocker(
    inner: &ServerInner,
    conn: &Connection,
    id: &str,
) -> Result<Option<&'static str>, SvcError> {
    // A7 (§3.7 item 5, W7): a verification in flight for any task of the
    // project. First, so it is named even though its live binding would
    // also block (a run always has one). The registry is a leaf lock read
    // under the DB mutex, the same critical section a run starts in.
    if inner.verifications.running_for_project(id) {
        return Ok(Some(crate::MSG_PROJECT_VERIFICATION_RUNNING));
    }
    // Non-terminal tasks. FAIL CLOSED: a stored status Core cannot read is
    // treated as not finished (`awaiting_review` is not terminal either).
    let mut stmt = conn
        .prepare(
            "SELECT t.id, t.status FROM tasks t
             JOIN conversations c ON c.id = t.conversation_id
             WHERE c.project_id = ?1",
        )
        .map_err(internal)?;
    let statuses = stmt
        .query_map(params![id], |r| {
            Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))
        })
        .map_err(internal)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(internal)?;
    let unfinished = statuses.iter().any(|(task_id, stored)| {
        task_status_from_stored(stored, task_id)
            .map(|s| !TaskStateMachine::from_status(s).is_terminal())
            .unwrap_or(true)
    });
    if unfinished {
        return Ok(Some(MSG_PROJECT_HAS_TASKS));
    }
    let live_bindings: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM sandbox_bindings WHERE project_id = ?1 AND removed_at IS NULL",
            params![id],
            |r| r.get(0),
        )
        .map_err(internal)?;
    if live_bindings > 0 {
        return Ok(Some(MSG_PROJECT_HAS_SANDBOXES));
    }
    if inner.project_creates.count(id) > 0 {
        return Ok(Some(MSG_PROJECT_CREATE_IN_FLIGHT));
    }
    Ok(None)
}

fn conflict(message: &str) -> SvcFailure {
    SvcFailure::from((ErrorCode::Conflict, message.to_string()))
}

fn count(conn: &Connection, sql: &str, id: &str) -> Result<i64, SvcError> {
    conn.query_row(sql, params![id], |r| r.get(0))
        .map_err(internal)
}

fn plural(n: i64, one: &str, many: &str) -> String {
    format!("{n} {}", if n == 1 { one } else { many })
}

/// What the delete dialog reports, read under the DB mutex. The worktree
/// paths are only COLLECTED here; whether each still exists on disk is
/// checked after the mutex is released (review I6: no filesystem I/O under
/// the DB lock).
struct DeleteImpact {
    conversations: i64,
    messages: i64,
    tasks: i64,
    repositories: i64,
    audit: i64,
    branches: i64,
    worktree_paths: Vec<String>,
}

/// Impact lines for the dialog (§3.2 item 5). Counts only, never content.
fn delete_impact(conn: &Connection, id: &str) -> Result<DeleteImpact, SvcError> {
    const CONV: &str = "(SELECT id FROM conversations WHERE project_id = ?1)";
    let conversations = count(
        conn,
        "SELECT COUNT(*) FROM conversations WHERE project_id = ?1",
        id,
    )?;
    let messages = count(
        conn,
        &format!("SELECT COUNT(*) FROM messages WHERE conversation_id IN {CONV}"),
        id,
    )?;
    let tasks = count(
        conn,
        &format!("SELECT COUNT(*) FROM tasks WHERE conversation_id IN {CONV}"),
        id,
    )?;
    let repositories = count(
        conn,
        "SELECT COUNT(*) FROM repositories WHERE project_id = ?1",
        id,
    )?;
    let audit = count(
        conn,
        "SELECT COUNT(*) FROM sandbox_bindings WHERE project_id = ?1 AND removed_at IS NOT NULL",
        id,
    )?;
    let branches = count(
        conn,
        &format!(
            "SELECT COUNT(DISTINCT task_branch) FROM tasks
             WHERE task_branch IS NOT NULL AND conversation_id IN {CONV}"
        ),
        id,
    )?;
    // Worktree directories Core allocated and has not removed.
    let worktree_paths = {
        let mut stmt = conn
            .prepare(&format!(
                "SELECT worktree_path FROM tasks
                 WHERE worktree_path IS NOT NULL AND worktree_removed_at IS NULL
                   AND conversation_id IN {CONV}"
            ))
            .map_err(internal)?;
        let paths = stmt
            .query_map(params![id], |r| r.get::<_, String>(0))
            .map_err(internal)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(internal)?;
        paths
    };
    Ok(DeleteImpact {
        conversations,
        messages,
        tasks,
        repositories,
        audit,
        branches,
        worktree_paths,
    })
}

/// Render [`DeleteImpact`]; called with NO Core lock held (it stats each
/// worktree path — a stat, never a git call or a delete).
fn impact_lines(i: &DeleteImpact, name: &str) -> Vec<String> {
    let DeleteImpact {
        conversations,
        messages,
        tasks,
        repositories,
        audit,
        branches,
        ..
    } = *i;
    let worktrees = i
        .worktree_paths
        .iter()
        .filter(|p| Path::new(p).is_dir())
        .count() as i64;
    vec![
        format!("deletes project {name} and all of its Core records; this cannot be undone"),
        format!(
            "{}, {} and {} are deleted, with their events, artifacts and verification records",
            plural(conversations, "conversation", "conversations"),
            plural(messages, "message", "messages"),
            plural(tasks, "task", "tasks"),
        ),
        format!(
            "{} {} unregistered; {} files are not touched",
            plural(
                repositories,
                "registered repository",
                "registered repositories"
            ),
            if repositories == 1 { "is" } else { "are" },
            if repositories == 1 { "its" } else { "their" },
        ),
        format!(
            "{} of removed sandboxes {} deleted with the project",
            plural(audit, "audit record", "audit records"),
            if audit == 1 { "is" } else { "are" },
        ),
        format!(
            "{} and {} in host repositories are left in place; Core never touches host files, \
             branches or sandboxes",
            plural(
                worktrees,
                "Core-allocated worktree directory",
                "Core-allocated worktree directories"
            ),
            plural(branches, "task branch", "task branches"),
        ),
    ]
}

/// Step 1: check the preconditions, describe the impact, issue a token bound
/// to `(project.delete, project id)`. Changes nothing.
fn issue_delete_confirmation(
    inner: &ServerInner,
    id: &str,
) -> Result<ConfirmationRequest, SvcFailure> {
    let (name, impact) = {
        let db = inner.lock_db();
        let row = project_row(db.conn(), id)?.ok_or_else(not_found)?;
        if let Some(m) = delete_blocker(inner, db.conn(), id)? {
            return Err(conflict(m));
        }
        let counts = delete_impact(db.conn(), id)?;
        (row.name, counts)
    };
    // DB mutex released: now stat the worktree paths.
    let impact = impact_lines(&impact, &name);
    // DB mutex released before the confirmation store is locked.
    let ttl = inner.confirmation_ttl;
    let token = inner
        .lock_confirmations()
        .issue(
            confirm::ConfirmationBinding {
                action: PROJECT_DELETE_ACTION.to_string(),
                // Display only: `consume_by_id` never compares it, so a
                // rename between the steps does not invalidate the token.
                name: name.clone(),
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
        action: PROJECT_DELETE_ACTION.to_string(),
        target: ConfirmationTarget {
            name,
            id: id.to_string(),
        },
        impact,
        // A project exists only in Core: nothing external to vouch for.
        external: false,
    })
}

/// Step 2: consume the token FIRST (every attempt burns it), then — under the
/// DB mutex, in ONE transaction — re-check existence and every precondition
/// and delete in an explicit FK-safe order. `ON DELETE CASCADE` removes the
/// rows hanging off each level (task events / artifacts / verifications;
/// messages / agent sessions; project context / workflows / client state)
/// and is otherwise only a backstop. `tasks.repo_id`,
/// `tasks.sandbox_binding_id` and `sandbox_bindings.repo_id` have NO cascade:
/// deleting tasks first, then bindings, then repositories keeps them
/// satisfied; a cross-project reference (no API writes one) would fail the
/// FK check, which rolls the whole transaction back and answers INTERNAL.
/// Host files, branches and sbx sandboxes are never touched.
fn delete_confirmed(inner: &ServerInner, id: &str, token: &str) -> Result<(), SvcFailure> {
    inner
        .lock_confirmations()
        .consume_by_id(token, PROJECT_DELETE_ACTION, id, std::time::Instant::now())
        .map_err(|confirm::TokenRejected| {
            SvcFailure::from((
                ErrorCode::ValidationFailed,
                confirm::TOKEN_REJECTED_MESSAGE.to_string(),
            ))
        })?;
    let db = inner.lock_db();
    let tx = db.conn().unchecked_transaction().map_err(internal)?;
    if project_row(&tx, id)?.is_none() {
        return Err(not_found().into());
    }
    if let Some(m) = delete_blocker(inner, &tx, id)? {
        return Err(conflict(m));
    }
    for sql in [
        // A7: verification runs before tasks…
        "DELETE FROM verification_runs WHERE task_id IN
             (SELECT t.id FROM tasks t JOIN conversations c ON c.id = t.conversation_id
              WHERE c.project_id = ?1)",
        "DELETE FROM tasks WHERE conversation_id IN
             (SELECT id FROM conversations WHERE project_id = ?1)",
        "DELETE FROM conversations WHERE project_id = ?1",
        "DELETE FROM sandbox_bindings WHERE project_id = ?1",
        "DELETE FROM repositories WHERE project_id = ?1",
        // …and verification commands before projects.
        "DELETE FROM verification_commands WHERE project_id = ?1",
        "DELETE FROM projects WHERE id = ?1",
    ] {
        tx.execute(sql, params![id]).map_err(internal)?;
    }
    tx.commit().map_err(internal)?;
    Ok(())
}

// ---------------------------------------------------------------------------
// project.add_repository / project.remove_repository (§3.2 items 6-7)
// ---------------------------------------------------------------------------

pub(crate) fn project_add_repository(
    inner: &ServerInner,
    p: ProjectRepositoryParams,
) -> Result<serde_json::Value, SvcError> {
    // Cheap refusal first, so an archived or unknown project never spends a
    // git subprocess.
    require_live_project(inner.lock_db().conn(), &p.project_id)?;
    // Same rules as project.create (W1), resolved with NO Core lock held.
    let canonical = canonical_repository(&inner.git, &p.path, &runtime::home_dir())?;
    let db = inner.lock_db();
    // Re-checked under the lock that guards the insert.
    require_live_project(db.conn(), &p.project_id)?;
    let registered: i64 = db
        .conn()
        .query_row(
            "SELECT COUNT(*) FROM repositories WHERE project_id = ?1 AND canonical_path = ?2",
            params![p.project_id, canonical],
            |r| r.get(0),
        )
        .map_err(internal)?;
    if registered == 0 {
        // Entry 0028: before the row exists (so before any task can target
        // it), stop using an excludes file that lies inside it.
        revet_excludes_for_new_repositories(inner, &db, std::slice::from_ref(&canonical));
        db.conn()
            .execute(
                "INSERT INTO repositories (id, project_id, canonical_path) VALUES (?1,?2,?3)",
                params![uuid::Uuid::new_v4().to_string(), p.project_id, canonical],
            )
            .map_err(internal)?;
    }
    serde_json::to_value(load_project(db.conn(), &p.project_id)?).map_err(internal)
}

pub(crate) fn project_remove_repository(
    inner: &ServerInner,
    p: ProjectRepositoryParams,
) -> Result<serde_json::Value, SvcError> {
    // The canonical form of the input, when it still resolves (a deleted
    // directory falls back to matching the stored string). Filesystem only,
    // no git, no Core lock held. The value is only ever an SQL parameter.
    // Review I2: an absolute path only (what add_repository requires too).
    if !Path::new(&p.path).is_absolute() {
        return Err((
            ErrorCode::ValidationFailed,
            format!("repository path must be absolute: {}", p.path),
        ));
    }
    let canonical_input = std::fs::canonicalize(&p.path)
        .ok()
        .and_then(|c| c.to_str().map(str::to_string));
    let db = inner.lock_db();
    let tx = db.conn().unchecked_transaction().map_err(internal)?;
    require_live_project(&tx, &p.project_id)?;
    let repo_id: Option<String> = tx
        .query_row(
            "SELECT id FROM repositories
             WHERE project_id = ?1 AND (canonical_path = ?2 OR canonical_path = ?3)
             ORDER BY (canonical_path = ?2) DESC, rowid LIMIT 1",
            params![p.project_id, p.path, canonical_input],
            |r| r.get(0),
        )
        .optional()
        .map_err(internal)?;
    let Some(repo_id) = repo_id else {
        return Err((
            ErrorCode::NotFound,
            MSG_REPOSITORY_NOT_REGISTERED.to_string(),
        ));
    };
    // §3.2 item 7 + review W1(c), all under the DB mutex:
    // * any task, or a LIVE binding recorded for this repository;
    // * CONSERVATIVE: any live binding of the project that mounts something
    //   (not `mountless`) but has no recorded repository — rows written
    //   before A3a recorded `repo_id`; Core cannot tell which repository
    //   they mount;
    // * a `sandbox.create` in flight for the project (it may be about to
    //   mount this repository; its post-claim re-check is the other half).
    let used: i64 = tx
        .query_row(
            "SELECT (SELECT COUNT(*) FROM tasks WHERE repo_id = ?1)
                  + (SELECT COUNT(*) FROM sandbox_bindings
                     WHERE repo_id = ?1 AND removed_at IS NULL)
                  + (SELECT COUNT(*) FROM sandbox_bindings
                     WHERE project_id = ?2 AND removed_at IS NULL AND repo_id IS NULL
                       AND workspace_mode NOT IN ('mountless', '\"mountless\"'))",
            params![repo_id, p.project_id],
            |r| r.get(0),
        )
        .map_err(internal)?;
    if used > 0 {
        return Err((ErrorCode::Conflict, MSG_REPOSITORY_IN_USE.to_string()));
    }
    if inner.project_creates.count(&p.project_id) > 0 {
        return Err((
            ErrorCode::Conflict,
            MSG_REPOSITORY_REMOVE_WHILE_CREATING.to_string(),
        ));
    }
    // Audit rows of REMOVED sandboxes keep their history but are detached
    // from the repository being unregistered (`repo_id` has no cascade; the
    // row would otherwise block the delete forever). Same transaction.
    tx.execute(
        "UPDATE sandbox_bindings SET repo_id = NULL
         WHERE repo_id = ?1 AND removed_at IS NOT NULL",
        params![repo_id],
    )
    .map_err(internal)?;
    tx.execute("DELETE FROM repositories WHERE id = ?1", params![repo_id])
        .map_err(internal)?;
    let project = load_project(&tx, &p.project_id)?;
    tx.commit().map_err(internal)?;
    serde_json::to_value(project).map_err(internal)
}

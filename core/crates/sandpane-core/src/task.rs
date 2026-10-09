//! Task lifecycle state machine (docs/specs/02 §4).
//!
//! Transitions are enforced HERE, in Core — never in a UI. Every accepted
//! transition is meant to be emitted as a durable event before subscribers
//! are notified (the service layer wires this to [`crate::events`]).

use sandpane_protocol::TaskStatus;
use thiserror::Error;

#[derive(Debug, Error, PartialEq, Eq)]
pub enum TaskStateError {
    #[error("illegal transition {from:?} -> {to:?}")]
    IllegalTransition { from: TaskStatus, to: TaskStatus },
}

pub struct TaskStateMachine {
    status: TaskStatus,
}

impl TaskStateMachine {
    pub fn new() -> Self {
        Self {
            status: TaskStatus::Created,
        }
    }

    pub fn from_status(status: TaskStatus) -> Self {
        Self { status }
    }

    pub fn status(&self) -> TaskStatus {
        self.status
    }

    /// Terminal states accept no further transitions (reconciliation after a
    /// crash creates a NEW machine instance set to `interrupted` via
    /// [`Self::from_status`], it never transitions an archived task).
    pub fn is_terminal(&self) -> bool {
        matches!(
            self.status,
            TaskStatus::Completed
                | TaskStatus::Rejected
                | TaskStatus::Failed
                | TaskStatus::Cancelled
                | TaskStatus::Interrupted
        )
    }

    /// Returns Ok(new_status) when the transition is legal per the lifecycle
    /// diagram in specs/02 §4, Err otherwise. There is deliberately NO `pause`
    /// state and no resume-from-terminal path.
    pub fn transition(&mut self, to: TaskStatus) -> Result<TaskStatus, TaskStateError> {
        let from = self.status;
        let legal = match (from, to) {
            (TaskStatus::Created, TaskStatus::Queued) => true,
            // A created-but-never-queued task can still be cancelled, or
            // interrupted by a crash before it was ever picked up.
            (TaskStatus::Created, TaskStatus::Cancelled) => true,
            (TaskStatus::Created, TaskStatus::Interrupted) => true,
            (TaskStatus::Queued, TaskStatus::Preparing) => true,
            (TaskStatus::Preparing, TaskStatus::Running) => true,
            (TaskStatus::Running, TaskStatus::Verifying) => true,
            (TaskStatus::Verifying, TaskStatus::AwaitingReview) => true,
            (TaskStatus::AwaitingReview, TaskStatus::Completed) => true,
            (TaskStatus::AwaitingReview, TaskStatus::Rejected) => true,
            // awaiting_input -> running when the adapter supports it
            (TaskStatus::Running, TaskStatus::AwaitingInput) => true,
            (TaskStatus::AwaitingInput, TaskStatus::Running) => true,
            // failure/cancel/interrupt from the in-flight states
            (TaskStatus::Queued, TaskStatus::Cancelled) => true,
            (TaskStatus::Queued, TaskStatus::Failed) => true,
            (TaskStatus::Preparing, TaskStatus::Failed) => true,
            (TaskStatus::Preparing, TaskStatus::Cancelled) => true,
            (TaskStatus::Running, TaskStatus::Failed) => true,
            (TaskStatus::Running, TaskStatus::Cancelled) => true,
            (TaskStatus::Running, TaskStatus::Interrupted) => true,
            (TaskStatus::Verifying, TaskStatus::Failed) => true,
            (TaskStatus::Verifying, TaskStatus::Cancelled) => true,
            (TaskStatus::Verifying, TaskStatus::Interrupted) => true,
            (TaskStatus::AwaitingInput, TaskStatus::Cancelled) => true,
            (TaskStatus::AwaitingInput, TaskStatus::Failed) => true,
            // A queued/preparing task interrupted by a service crash.
            (TaskStatus::Queued, TaskStatus::Interrupted) => true,
            (TaskStatus::Preparing, TaskStatus::Interrupted) => true,
            _ => false,
        };
        if !legal {
            return Err(TaskStateError::IllegalTransition { from, to });
        }
        self.status = to;
        Ok(to)
    }
}

impl Default for TaskStateMachine {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn run_to(status: TaskStatus) -> TaskStateMachine {
        let mut m = TaskStateMachine::new();
        let path: Vec<TaskStatus> = match status {
            TaskStatus::Queued => vec![TaskStatus::Queued],
            TaskStatus::Preparing => vec![TaskStatus::Queued, TaskStatus::Preparing],
            TaskStatus::Running => vec![
                TaskStatus::Queued,
                TaskStatus::Preparing,
                TaskStatus::Running,
            ],
            TaskStatus::Verifying => vec![
                TaskStatus::Queued,
                TaskStatus::Preparing,
                TaskStatus::Running,
                TaskStatus::Verifying,
            ],
            TaskStatus::AwaitingReview => vec![
                TaskStatus::Queued,
                TaskStatus::Preparing,
                TaskStatus::Running,
                TaskStatus::Verifying,
                TaskStatus::AwaitingReview,
            ],
            TaskStatus::Completed => vec![
                TaskStatus::Queued,
                TaskStatus::Preparing,
                TaskStatus::Running,
                TaskStatus::Verifying,
                TaskStatus::AwaitingReview,
                TaskStatus::Completed,
            ],
            other => panic!("test helper: build path for {other:?}"),
        };
        for s in path {
            m.transition(s).expect("path must be legal");
        }
        m
    }

    #[test]
    fn happy_path() {
        let m = run_to(TaskStatus::Completed);
        assert_eq!(m.status(), TaskStatus::Completed);
        assert!(m.is_terminal());
    }

    #[test]
    fn awaiting_input_roundtrip() {
        let mut m = run_to(TaskStatus::Running);
        m.transition(TaskStatus::AwaitingInput).unwrap();
        m.transition(TaskStatus::Running).unwrap();
        m.transition(TaskStatus::Verifying).unwrap();
    }

    #[test]
    fn illegal_transitions_rejected() {
        let mut m = TaskStateMachine::new();
        // Cannot skip the queue.
        assert_eq!(
            m.transition(TaskStatus::Running),
            Err(TaskStateError::IllegalTransition {
                from: TaskStatus::Created,
                to: TaskStatus::Running
            })
        );
        // Cannot complete straight from created.
        assert!(m.transition(TaskStatus::Completed).is_err());

        let mut m = run_to(TaskStatus::Running);
        // Running cannot go back to queued or jump to awaiting_review.
        assert!(m.transition(TaskStatus::Queued).is_err());
        assert!(m.transition(TaskStatus::AwaitingReview).is_err());
    }

    #[test]
    fn terminal_states_are_final() {
        for t in [
            TaskStatus::Completed,
            TaskStatus::Rejected,
            TaskStatus::Failed,
            TaskStatus::Cancelled,
            TaskStatus::Interrupted,
        ] {
            let mut m = TaskStateMachine::from_status(t);
            assert!(m.is_terminal());
            for to in [
                TaskStatus::Created,
                TaskStatus::Queued,
                TaskStatus::Running,
                TaskStatus::Completed,
            ] {
                assert!(m.transition(to).is_err(), "{t:?} -> {to:?} accepted");
            }
        }
    }

    #[test]
    fn rejection_from_review() {
        let mut m = run_to(TaskStatus::AwaitingReview);
        m.transition(TaskStatus::Rejected).unwrap();
        assert!(m.is_terminal());
    }

    #[test]
    fn cancel_and_interrupt_from_inflight() {
        let mut m = run_to(TaskStatus::Running);
        m.transition(TaskStatus::Interrupted).unwrap();

        let mut m = run_to(TaskStatus::Preparing);
        m.transition(TaskStatus::Cancelled).unwrap();

        let mut m = run_to(TaskStatus::Queued);
        m.transition(TaskStatus::Interrupted).unwrap();
    }

    #[test]
    fn no_pause_state_exists() {
        // The lifecycle has no pause/resume-of-process fiction (specs/02 §4).
        let m = run_to(TaskStatus::Running);
        assert!(!m.is_terminal());
        // Nothing to transition to that "pauses": only the documented states exist.
    }
}

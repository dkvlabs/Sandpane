//! Git object ids computed by Core itself (design 2026-10-09 §3.6 item 3).
//!
//! A6 binds an apply to the exact bytes Core read from the task worktree, so
//! the blob id is computed here — never by running git on agent-written
//! files. `blob_id` is git's `H("blob <len>\0" + bytes)`:
//!
//! - **SHA-1** repositories use a COLLISION-DETECTING SHA-1
//!   (`sha1collisiondetection`, a port of the same sha1dc code git links).
//!   Git configures it with collision detection ON and the "safe hash"
//!   mitigation OFF, and dies when an attack is detected; Core does the
//!   same — identical ids for ordinary content, and a detected collision is
//!   an error, never an id.
//! - **SHA-256** repositories use `sha2`.
//!
//! The object format is read ONCE per operation from the HOST repository's
//! common dir config (`extensions.objectFormat`, R3), never from the task
//! worktree.

use sha1collisiondetection::Sha1CD;
use sha2::{Digest, Sha256};
use thiserror::Error;

/// A repository's object format (`extensions.objectFormat`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ObjectFormat {
    Sha1,
    Sha256,
}

impl ObjectFormat {
    /// The format named by an `extensions.objectFormat` value; absent means
    /// SHA-1 (git's default). Anything else fails CLOSED.
    pub fn from_config(value: Option<&str>) -> Result<Self, ObjectError> {
        match value.map(|v| v.trim().to_ascii_lowercase()) {
            None => Ok(Self::Sha1),
            Some(v) if v == "sha1" => Ok(Self::Sha1),
            Some(v) if v == "sha256" => Ok(Self::Sha256),
            Some(other) => Err(ObjectError::UnknownFormat(other)),
        }
    }

    /// Hex length of a full object id in this format.
    pub fn hex_len(self) -> usize {
        match self {
            Self::Sha1 => 40,
            Self::Sha256 => 64,
        }
    }
}

#[derive(Debug, Error, PartialEq, Eq)]
pub enum ObjectError {
    #[error("unknown object format {0:?}")]
    UnknownFormat(String),
    /// sha1dc found the signature of a SHA-1 collision attack in the content
    /// (git dies with "SHA-1 appears to be part of a collision attack").
    #[error("the content appears to be part of a SHA-1 collision attack")]
    Sha1Collision,
}

/// Collision-detecting SHA-1 over the concatenation of `parts`, configured
/// like git's sha1dc (detection on, mitigation off).
pub fn sha1_checked(parts: &[&[u8]]) -> Result<[u8; 20], ObjectError> {
    let mut ctx = Sha1CD::configure()
        .detect_collisions(true)
        .safe_hash(false)
        .build();
    for p in parts {
        ctx.update(p);
    }
    let digest = ctx.finalize_cd().map_err(|_| ObjectError::Sha1Collision)?;
    let mut out = [0u8; 20];
    out.copy_from_slice(&digest[..]);
    Ok(out)
}

/// The git blob id of `content` in `format`, as lowercase hex.
pub fn blob_id(format: ObjectFormat, content: &[u8]) -> Result<String, ObjectError> {
    let header = format!("blob {}\0", content.len());
    match format {
        ObjectFormat::Sha1 => Ok(hex(&sha1_checked(&[header.as_bytes(), content])?)),
        ObjectFormat::Sha256 => {
            let mut h = Sha256::new();
            h.update(header.as_bytes());
            h.update(content);
            Ok(hex(&h.finalize()))
        }
    }
}

fn hex(bytes: &[u8]) -> String {
    const DIGITS: &[u8; 16] = b"0123456789abcdef";
    let mut s = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        s.push(DIGITS[(b >> 4) as usize] as char);
        s.push(DIGITS[(b & 0xf) as usize] as char);
    }
    s
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;
    use std::process::Command;

    /// SHA-mbles chosen-prefix collision vector (Leurent & Peyrin, 2020), as
    /// shipped in the MIT-licensed `sha1collisiondetection` crate's tests.
    const SHAMBLES_1: &[u8] = include_bytes!("../testdata/sha-mbles-1.bin");

    fn git_hash_object(dir: &Path, file: &Path) -> String {
        let out = Command::new("git")
            .args(["hash-object", "--no-filters", "--"])
            .arg(file)
            .current_dir(dir)
            .output()
            .unwrap();
        assert!(
            out.status.success(),
            "{}",
            String::from_utf8_lossy(&out.stderr)
        );
        String::from_utf8(out.stdout).unwrap().trim().to_string()
    }

    fn init(dir: &Path, format: &str) {
        let out = Command::new("git")
            .args(["init", "-q", &format!("--object-format={format}")])
            .arg(dir)
            .output()
            .unwrap();
        assert!(
            out.status.success(),
            "{}",
            String::from_utf8_lossy(&out.stderr)
        );
    }

    /// Oracle: Core's id equals `git hash-object` for several contents, in
    /// a SHA-1 and a SHA-256 repository.
    #[test]
    fn blob_ids_match_git_hash_object_in_both_formats() {
        let dir = tempfile::tempdir().unwrap();
        let contents: [&[u8]; 6] = [
            b"",
            b"hello\n",
            b"no newline",
            b"a\0binary\xff\xfe",
            b"crlf\r\nline\r\n",
            &[b'x'; 70_000],
        ];
        for (fmt, name) in [
            (ObjectFormat::Sha1, "sha1"),
            (ObjectFormat::Sha256, "sha256"),
        ] {
            let repo = dir.path().join(name);
            init(&repo, name);
            for (i, c) in contents.iter().enumerate() {
                let f = repo.join(format!("f{i}"));
                std::fs::write(&f, c).unwrap();
                let ours = blob_id(fmt, c).unwrap();
                assert_eq!(ours.len(), fmt.hex_len());
                assert_eq!(ours, git_hash_object(&repo, &f), "{name} #{i}");
            }
        }
    }

    /// The SHA-1 is collision-DETECTING (git's sha1dc), not plain SHA-1: a
    /// known collision block is refused instead of hashed.
    #[test]
    fn a_sha1_collision_attack_is_refused_not_hashed() {
        assert_eq!(sha1_checked(&[SHAMBLES_1]), Err(ObjectError::Sha1Collision));
        // Ordinary input hashes (empty string, standard vector).
        assert_eq!(
            hex(&sha1_checked(&[b"abc"]).unwrap()),
            "a9993e364706816aba3e25717850c26c9cd0d89d"
        );
        assert_eq!(
            hex(&sha1_checked(&[b"a", b"bc"]).unwrap()),
            "a9993e364706816aba3e25717850c26c9cd0d89d",
            "parts are concatenated"
        );
    }

    #[test]
    fn object_format_parsing_fails_closed() {
        assert_eq!(ObjectFormat::from_config(None), Ok(ObjectFormat::Sha1));
        assert_eq!(
            ObjectFormat::from_config(Some("SHA1")),
            Ok(ObjectFormat::Sha1)
        );
        assert_eq!(
            ObjectFormat::from_config(Some("sha256\n")),
            Ok(ObjectFormat::Sha256)
        );
        assert!(ObjectFormat::from_config(Some("md5")).is_err());
        assert!(ObjectFormat::from_config(Some("")).is_err());
    }
}

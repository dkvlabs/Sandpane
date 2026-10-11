//! A7 `project.context` (design of record
//! `docs/plans/2026-10-09-protocol-v1-additions.md` §3.7 item 9, W8):
//! bounded, read-only detection of verification commands from a registered
//! repository's ROOT manifests. Core never runs `npm`, `cargo`, `make`,
//! `gradle` or any other tool, and adds no dependency: JSON goes through
//! `serde_json::Value` with its default recursion limit (never disabled); a
//! duplicate key takes the LAST value, like `JSON.parse` (pinned below).
//!
//! The root is opened `O_DIRECTORY | O_NOFOLLOW` with an identity check
//! against the registered canonical path ([`crate::diff::open_root_checked`]);
//! every manifest is read with the A5 race-safe leaf read
//! ([`crate::diff::read_regular_at`]: `O_NOFOLLOW` leaf, regular file only,
//! inode check). A file over [`MAX_MANIFEST_BYTES`], a symlink, a UTF-8
//! BOM, invalid JSON or an unreadable file goes into `unreadable` BY NAME,
//! with nothing taken from it. Suggestions and notes are UNTRUSTED display
//! strings: never auto-approved, never run.

use std::path::Path;

use crate::diff::{self, RegularLeaf};

/// Per-file read cap.
pub const MAX_MANIFEST_BYTES: usize = 256 * 1024;
/// Per-note cap, in bytes (a cut note ends with `…`).
pub const MAX_NOTE_BYTES: usize = 512;
/// Root entries examined when looking for manifest names.
pub const MAX_ROOT_ENTRIES: usize = 100_000;
/// Lines scanned in a make file.
pub const MAX_MAKEFILE_LINES: usize = 20_000;

/// Carried by every detected manifest's notes (§3.7 item 9).
pub const NOTE_CURRENT_FILE: &str = "this is the file in your registered repository now; the copy \
     that runs in the sandbox may differ, and it runs in sbx's default working directory";
pub const NOTE_NPMRC: &str = "this repository has an .npmrc that can change how npm runs scripts";
pub const NOTE_GRADLE_WRAPPER: &str = "the Gradle wrapper may download Gradle from the URL in \
     gradle/wrapper/gradle-wrapper.properties";
pub const NOTE_PYTEST: &str = "assumes pytest";
/// A note replaced because the secret check was unavailable (S2).
pub const NOTE_WITHHELD: &str = "this note was withheld because the secret check is unavailable";
/// `unreadable` entry when the repository ROOT itself cannot be opened or
/// fails the identity check (nothing in it is read).
pub const UNREADABLE_ROOT: &str = ".";

/// Root names Core looks at (exact, case-sensitive).
const ROOT_NAMES: [&str; 11] = [
    "package.json",
    ".npmrc",
    "Cargo.toml",
    "go.mod",
    "GNUmakefile",
    "makefile",
    "Makefile",
    "gradlew",
    "build.gradle.kts",
    "build.gradle",
    "pyproject.toml",
];

/// GNU make's lookup order.
const MAKEFILE_ORDER: [&str; 3] = ["GNUmakefile", "makefile", "Makefile"];
/// `package.json` scripts suggested, in this order.
const NPM_SCRIPTS: [&str; 4] = ["test", "check", "lint", "build"];
/// make targets suggested, in this order.
const MAKE_TARGETS: [&str; 2] = ["test", "check"];

/// One detected manifest.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Detected {
    pub manifest: String,
    pub suggested_commands: Vec<Vec<String>>,
    pub notes: Vec<String>,
}

/// What one repository root yielded.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct RepoContext {
    pub detected: Vec<Detected>,
    pub unreadable: Vec<String>,
}

/// Cap a note at [`MAX_NOTE_BYTES`] on a char boundary (a cut note ends
/// with `…`, counted inside the cap).
pub fn cap_note(text: &str) -> String {
    if text.len() <= MAX_NOTE_BYTES {
        return text.to_string();
    }
    let ellipsis = "…";
    let mut end = MAX_NOTE_BYTES - ellipsis.len();
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    format!("{}{ellipsis}", &text[..end])
}

fn argv(items: &[&str]) -> Vec<String> {
    items.iter().map(|s| s.to_string()).collect()
}

/// One manifest's bytes, or why it went to `unreadable`.
enum Read {
    Missing,
    Unreadable,
    Bytes(Vec<u8>),
}

fn read_manifest(dir: &std::os::fd::OwnedFd, name: &str) -> Read {
    match diff::read_regular_at(dir, name, MAX_MANIFEST_BYTES) {
        Ok(RegularLeaf::Absent) => Read::Missing,
        Ok(RegularLeaf::File { over_cap: true, .. }) => Read::Unreadable,
        Ok(RegularLeaf::File { bytes, .. }) if bytes.starts_with(b"\xef\xbb\xbf") => {
            Read::Unreadable
        }
        Ok(RegularLeaf::File { bytes, .. }) => Read::Bytes(bytes),
        Ok(RegularLeaf::NotRegular) | Err(_) => Read::Unreadable,
    }
}

/// Detect suggestions in the registered repository root `root` (its stored
/// canonical path). Never fails: what cannot be read is listed by name, and
/// a root that cannot be opened or fails the identity check is listed as
/// [`UNREADABLE_ROOT`] with nothing read from it.
pub fn detect(root: &Path) -> RepoContext {
    let mut out = detect_raw(root);
    // Security review S2: notes quote repository text (npm scripts) — run
    // the best-effort redactor over each one; a replacement is shown with
    // the redaction marker. Re-capped, since a marker can be longer than
    // what it replaced. Redactor unavailable: the note is withheld.
    for d in &mut out.detected {
        for n in &mut d.notes {
            let mut counts = crate::redact::RedactionCounts::default();
            *n = match crate::redact::redact(n, &mut counts) {
                Ok(text) => cap_note(&text),
                Err(_) => NOTE_WITHHELD.to_string(),
            };
        }
    }
    out
}

fn detect_raw(root: &Path) -> RepoContext {
    let mut out = RepoContext::default();
    let Ok(dir) = diff::open_root_checked(root) else {
        out.unreadable.push(UNREADABLE_ROOT.to_string());
        return out;
    };
    let Ok(names) = diff::exact_names_in(&dir, &ROOT_NAMES, MAX_ROOT_ENTRIES) else {
        out.unreadable.push(UNREADABLE_ROOT.to_string());
        return out;
    };
    let has = |n: &str| names.iter().any(|x| x == n);
    let unreadable = |out: &mut RepoContext, n: &str| out.unreadable.push(n.to_string());

    // package.json
    if has("package.json") {
        match read_manifest(&dir, "package.json") {
            Read::Missing => {}
            Read::Unreadable => unreadable(&mut out, "package.json"),
            Read::Bytes(b) => match serde_json::from_slice::<serde_json::Value>(&b) {
                Err(_) => unreadable(&mut out, "package.json"),
                Ok(v) => {
                    let scripts = v.get("scripts").and_then(|s| s.as_object());
                    let script = |k: &str| scripts.and_then(|m| m.get(k)).and_then(|x| x.as_str());
                    let mut suggested = Vec::new();
                    let mut notes = Vec::new();
                    for name in NPM_SCRIPTS {
                        let Some(text) = script(name) else { continue };
                        suggested.push(argv(&["npm", "run", name]));
                        notes.push(cap_note(&format!("npm run {name} runs: {text}")));
                        if let Some(pre) = script(&format!("pre{name}")) {
                            notes.push(cap_note(&format!(
                                "npm run {name} first runs pre{name}: {pre}"
                            )));
                        }
                        if let Some(post) = script(&format!("post{name}")) {
                            notes.push(cap_note(&format!(
                                "npm run {name} then runs post{name}: {post}"
                            )));
                        }
                    }
                    if has(".npmrc") {
                        notes.push(NOTE_NPMRC.to_string());
                    }
                    notes.push(NOTE_CURRENT_FILE.to_string());
                    out.detected.push(Detected {
                        manifest: "package.json".into(),
                        suggested_commands: suggested,
                        notes,
                    });
                }
            },
        }
    }

    // Presence-only manifests (still read: regular file, cap, no BOM).
    for (name, cmd, extra) in [
        ("Cargo.toml", &["cargo", "test"][..], None),
        ("go.mod", &["go", "test", "./..."][..], None),
    ] {
        presence(&mut out, &dir, has(name), name, cmd, extra);
    }

    // make: the FIRST present name in GNU make's order decides — a symlinked
    // or unreadable GNUmakefile is reported, never skipped for a later one.
    if let Some(name) = MAKEFILE_ORDER.iter().copied().find(|n| has(n)) {
        match read_manifest(&dir, name) {
            Read::Missing => {}
            Read::Unreadable => unreadable(&mut out, name),
            Read::Bytes(b) => {
                let lines: Vec<&[u8]> = b.split(|c| *c == b'\n').take(MAX_MAKEFILE_LINES).collect();
                let suggested = MAKE_TARGETS
                    .iter()
                    .filter(|t| {
                        let prefix = format!("{t}:");
                        lines.iter().any(|l| l.starts_with(prefix.as_bytes()))
                    })
                    .map(|t| argv(&["make", t]))
                    .collect();
                out.detected.push(Detected {
                    manifest: name.to_string(),
                    suggested_commands: suggested,
                    notes: vec![
                        format!(
                            "GNU make reads {name} (the first of GNUmakefile, makefile, Makefile \
                             in this directory); only lines starting with \"<target>:\" were matched"
                        ),
                        NOTE_CURRENT_FILE.to_string(),
                    ],
                });
            }
        }
    }

    // Gradle: the wrapper FILE plus a build file.
    let build = ["build.gradle.kts", "build.gradle"]
        .into_iter()
        .find(|n| has(n));
    if let (true, Some(build)) = (has("gradlew"), build) {
        match (read_manifest(&dir, "gradlew"), read_manifest(&dir, build)) {
            (Read::Bytes(_), Read::Bytes(_)) => out.detected.push(Detected {
                manifest: build.to_string(),
                suggested_commands: vec![argv(&["./gradlew", "test"])],
                notes: vec![
                    NOTE_GRADLE_WRAPPER.to_string(),
                    NOTE_CURRENT_FILE.to_string(),
                ],
            }),
            (w, b) => {
                if matches!(w, Read::Unreadable) {
                    unreadable(&mut out, "gradlew");
                }
                if matches!(b, Read::Unreadable) {
                    unreadable(&mut out, build);
                }
            }
        }
    }

    presence(
        &mut out,
        &dir,
        has("pyproject.toml"),
        "pyproject.toml",
        &["python", "-m", "pytest"],
        Some(NOTE_PYTEST),
    );
    out
}

fn presence(
    out: &mut RepoContext,
    dir: &std::os::fd::OwnedFd,
    present: bool,
    name: &str,
    cmd: &[&str],
    extra_note: Option<&str>,
) {
    if !present {
        return;
    }
    match read_manifest(dir, name) {
        Read::Missing => {}
        Read::Unreadable => out.unreadable.push(name.to_string()),
        Read::Bytes(_) => {
            let mut notes: Vec<String> = extra_note.map(str::to_string).into_iter().collect();
            notes.push(NOTE_CURRENT_FILE.to_string());
            out.detected.push(Detected {
                manifest: name.to_string(),
                suggested_commands: vec![argv(cmd)],
                notes,
            });
        }
    }
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn root() -> (tempfile::TempDir, PathBuf) {
        let d = tempfile::tempdir().unwrap();
        let p = std::fs::canonicalize(d.path()).unwrap().join("repo");
        std::fs::create_dir(&p).unwrap();
        (d, p)
    }

    fn write(dir: &Path, name: &str, body: &str) {
        std::fs::write(dir.join(name), body).unwrap();
    }

    fn sugg(r: &RepoContext, manifest: &str) -> Vec<Vec<String>> {
        r.detected
            .iter()
            .find(|d| d.manifest == manifest)
            .unwrap_or_else(|| panic!("{manifest} not detected: {r:?}"))
            .suggested_commands
            .clone()
    }

    fn notes(r: &RepoContext, manifest: &str) -> Vec<String> {
        r.detected
            .iter()
            .find(|d| d.manifest == manifest)
            .unwrap()
            .notes
            .clone()
    }

    #[test]
    fn package_json_scripts_pre_post_and_npmrc() {
        let (_d, p) = root();
        write(
            &p,
            "package.json",
            r#"{"name":"atlas-demo","scripts":{"build":"tsc","test":"vitest run",
               "pretest":"node setup.js","posttest":"node cleanup.js","lint":"eslint .",
               "deploy":"rm -rf /","check":42}}"#,
        );
        write(&p, ".npmrc", "ignore-scripts=false\n");
        let r = detect(&p);
        assert!(r.unreadable.is_empty(), "{r:?}");
        // In test, check, lint, build order; `check` is not a string → skipped;
        // `deploy` is never suggested.
        assert_eq!(
            sugg(&r, "package.json"),
            vec![
                argv(&["npm", "run", "test"]),
                argv(&["npm", "run", "lint"]),
                argv(&["npm", "run", "build"])
            ]
        );
        let n = notes(&r, "package.json");
        assert!(
            n.contains(&"npm run test runs: vitest run".to_string()),
            "{n:?}"
        );
        assert!(
            n.contains(&"npm run test first runs pretest: node setup.js".to_string()),
            "{n:?}"
        );
        assert!(
            n.contains(&"npm run test then runs posttest: node cleanup.js".to_string()),
            "{n:?}"
        );
        assert!(n.contains(&NOTE_NPMRC.to_string()), "{n:?}");
        assert_eq!(n.last().unwrap(), NOTE_CURRENT_FILE);
        assert!(!n.iter().any(|x| x.contains("rm -rf")), "{n:?}");
    }

    #[test]
    fn presence_only_manifests() {
        let (_d, p) = root();
        write(&p, "Cargo.toml", "[package]\nname = \"atlas\"\n");
        write(&p, "go.mod", "module example.invalid/atlas\n");
        write(&p, "pyproject.toml", "[project]\nname = \"atlas\"\n");
        let r = detect(&p);
        assert_eq!(sugg(&r, "Cargo.toml"), vec![argv(&["cargo", "test"])]);
        assert_eq!(sugg(&r, "go.mod"), vec![argv(&["go", "test", "./..."])]);
        assert_eq!(
            sugg(&r, "pyproject.toml"),
            vec![argv(&["python", "-m", "pytest"])]
        );
        assert!(notes(&r, "pyproject.toml").contains(&NOTE_PYTEST.to_string()));
        assert_eq!(notes(&r, "Cargo.toml"), vec![NOTE_CURRENT_FILE.to_string()]);
        assert!(r.unreadable.is_empty());
    }

    #[test]
    fn makefile_order_and_bounded_target_scan() {
        let (_d, p) = root();
        write(
            &p,
            "Makefile",
            "build:\n\tcc\ntest: build\n\t./t\n  check:\n",
        );
        let r = detect(&p);
        assert_eq!(sugg(&r, "Makefile"), vec![argv(&["make", "test"])]);
        assert!(notes(&r, "Makefile")[0].contains("Makefile"), "{r:?}");
        // GNUmakefile wins over Makefile (GNU make's order).
        write(&p, "GNUmakefile", "check:\n\ttrue\n");
        let r = detect(&p);
        assert!(r.detected.iter().all(|d| d.manifest != "Makefile"), "{r:?}");
        assert_eq!(sugg(&r, "GNUmakefile"), vec![argv(&["make", "check"])]);
        assert!(notes(&r, "GNUmakefile")[0].contains("GNUmakefile"));
    }

    #[test]
    fn lowercase_makefile_is_found_by_its_real_name() {
        let (_d, p) = root();
        write(&p, "makefile", "test:\n\ttrue\n");
        let r = detect(&p);
        // Exact names from the directory listing: on a case-insensitive
        // volume `Makefile` would also open, but the note names the real file.
        assert_eq!(sugg(&r, "makefile"), vec![argv(&["make", "test"])]);
        assert!(r.detected.iter().all(|d| d.manifest != "Makefile"), "{r:?}");
    }

    #[test]
    fn gradle_needs_the_wrapper_file_and_a_build_file() {
        let (_d, p) = root();
        write(&p, "build.gradle.kts", "plugins {}\n");
        assert!(detect(&p).detected.is_empty(), "no wrapper, no suggestion");
        write(&p, "gradlew", "#!/bin/sh\n");
        let r = detect(&p);
        assert_eq!(
            sugg(&r, "build.gradle.kts"),
            vec![argv(&["./gradlew", "test"])]
        );
        assert!(notes(&r, "build.gradle.kts").contains(&NOTE_GRADLE_WRAPPER.to_string()));
        // A wrapper that is a directory is not a file: unreadable, no suggestion.
        let (_d2, q) = root();
        write(&q, "build.gradle", "x\n");
        std::fs::create_dir(q.join("gradlew")).unwrap();
        let r = detect(&q);
        assert!(r.detected.is_empty(), "{r:?}");
        assert_eq!(r.unreadable, vec!["gradlew".to_string()]);
    }

    #[test]
    fn symlinked_oversized_bom_and_invalid_manifests_are_unreadable_by_name() {
        let (d, p) = root();
        let outside = d.path().join("outside.json");
        std::fs::write(&outside, r#"{"scripts":{"test":"pwned"}}"#).unwrap();
        std::os::unix::fs::symlink(&outside, p.join("package.json")).unwrap();
        write(&p, "Cargo.toml", &"#".repeat(MAX_MANIFEST_BYTES + 1));
        write(&p, "go.mod", "\u{feff}module x\n");
        write(&p, "pyproject.toml", "ok\n");
        let r = detect(&p);
        let mut u = r.unreadable.clone();
        u.sort();
        assert_eq!(u, vec!["Cargo.toml", "go.mod", "package.json"]);
        assert_eq!(r.detected.len(), 1, "{r:?}");
        assert_eq!(r.detected[0].manifest, "pyproject.toml");
        // Exactly at the cap is fine.
        write(&p, "Cargo.toml", &"#".repeat(MAX_MANIFEST_BYTES));
        assert!(detect(&p)
            .detected
            .iter()
            .any(|x| x.manifest == "Cargo.toml"));
        // Invalid JSON and a BOM-prefixed package.json.
        let (_d2, q) = root();
        write(&q, "package.json", "{\"scripts\": {");
        assert_eq!(detect(&q).unreadable, vec!["package.json".to_string()]);
        write(&q, "package.json", "\u{feff}{\"scripts\":{\"test\":\"x\"}}");
        assert_eq!(detect(&q).unreadable, vec!["package.json".to_string()]);
    }

    #[test]
    fn deeply_nested_json_hits_the_default_recursion_limit() {
        let (_d, p) = root();
        let deep = format!("{}{}", "[".repeat(1000), "]".repeat(1000));
        write(
            &p,
            "package.json",
            &format!("{{\"scripts\":{{\"test\":\"t\"}},\"x\":{deep}}}"),
        );
        let r = detect(&p);
        assert_eq!(r.unreadable, vec!["package.json".to_string()]);
        assert!(r.detected.is_empty());
    }

    /// A duplicate key takes the LAST value (like `JSON.parse`).
    #[test]
    fn duplicate_keys_take_the_last_value() {
        let (_d, p) = root();
        write(
            &p,
            "package.json",
            r#"{"scripts":{"test":"first"},"scripts":{"test":"second","test":"third"}}"#,
        );
        let r = detect(&p);
        assert!(notes(&r, "package.json").contains(&"npm run test runs: third".to_string()));
    }

    #[test]
    fn hostile_script_text_is_kept_as_data_and_capped() {
        let (_d, p) = root();
        let osc8 = "\u{1b}]8;;https://evil.invalid\u{7}click\u{1b}]8;;\u{7}";
        let long = "x".repeat(2000);
        let body = serde_json::json!({"scripts": {"test": format!("{osc8} {long}"), "lint": "é".repeat(600)}});
        write(&p, "package.json", &body.to_string());
        let r = detect(&p);
        for n in notes(&r, "package.json") {
            assert!(n.len() <= MAX_NOTE_BYTES, "{} bytes", n.len());
        }
        let n = notes(&r, "package.json");
        assert!(
            n[0].starts_with("npm run test runs: \u{1b}]8;;"),
            "raw, not interpreted"
        );
        assert!(n[0].ends_with('…'));
        assert!(n
            .iter()
            .any(|x| x.starts_with("npm run lint runs: é") && x.ends_with('…')));
    }

    #[test]
    fn a_symlinked_or_moved_root_is_refused_whole() {
        let (d, p) = root();
        write(&p, "Cargo.toml", "x\n");
        let link = d.path().canonicalize().unwrap().join("link");
        std::os::unix::fs::symlink(&p, &link).unwrap();
        let r = detect(&link);
        assert_eq!(r.unreadable, vec![UNREADABLE_ROOT.to_string()]);
        assert!(r.detected.is_empty());
        // A missing root.
        let r = detect(&d.path().canonicalize().unwrap().join("gone"));
        assert_eq!(r.unreadable, vec![UNREADABLE_ROOT.to_string()]);
        // A root whose PARENT became a symlink no longer canonicalizes to itself.
        let real_parent = d.path().canonicalize().unwrap().join("real");
        std::fs::create_dir(&real_parent).unwrap();
        std::fs::create_dir(real_parent.join("repo")).unwrap();
        let alias = d.path().canonicalize().unwrap().join("alias");
        std::os::unix::fs::symlink(&real_parent, &alias).unwrap();
        let r = detect(&alias.join("repo"));
        assert_eq!(r.unreadable, vec![UNREADABLE_ROOT.to_string()]);
    }

    #[test]
    fn nothing_detected_in_an_empty_root() {
        let (_d, p) = root();
        assert_eq!(detect(&p), RepoContext::default());
    }

    #[test]
    fn notes_are_redacted_before_they_are_returned() {
        let (_d, root) = root();
        write(
            &root,
            "package.json",
            r#"{"scripts":{"test":"curl -H 'Authorization: Bearer q7Zr2LkP9xVb3NcT8mWd4HfJ6sYa1GeU5oRi0tQk' x"}}"#,
        );
        let r = detect(&root);
        let n = notes(&r, "package.json");
        let run = n
            .iter()
            .find(|n| n.starts_with("npm run test runs:"))
            .unwrap();
        assert!(run.contains("[REDACTED:auth-header]"), "{run}");
        assert!(
            !run.contains("q7Zr2LkP9xVb3NcT8mWd4HfJ6sYa1GeU5oRi0tQk"),
            "{run}"
        );
    }

    #[test]
    fn the_make_note_names_the_file_in_one_sentence() {
        let (_d, root) = root();
        write(&root, "makefile", "test:\n\techo\n");
        let r = detect(&root);
        assert_eq!(
            notes(&r, "makefile")[0],
            "GNU make reads makefile (the first of GNUmakefile, makefile, Makefile in this \
             directory); only lines starting with \"<target>:\" were matched"
        );
    }

    #[test]
    fn notes_are_capped_on_a_char_boundary() {
        assert_eq!(cap_note("short"), "short");
        let s = "é".repeat(400);
        let c = cap_note(&s);
        assert!(c.len() <= MAX_NOTE_BYTES && c.ends_with('…'), "{}", c.len());
        assert!(s.starts_with(c.trim_end_matches('…')));
    }
}

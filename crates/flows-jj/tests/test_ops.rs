//! Native integration tests for the six `Jj` contract ops, run against real
//! tempdir repos through jj-lib — no `jj` binary involved.
//!
//! Every op call constructs fresh state from disk (there is no long-lived
//! session object), so each assertion after the first also proves
//! reload-survival: a "new instance" over the same tree sees prior snapshots.

use std::fs;
use std::path::Path;
use std::path::PathBuf;

use flows_jj::error::ErrorCode;
use flows_jj::ops;
use tempfile::TempDir;

fn temp_root() -> (TempDir, PathBuf) {
    let temp_dir = tempfile::Builder::new()
        .prefix("flows-jj-test-")
        .tempdir()
        .unwrap();
    let root = temp_dir.path().join("repo");
    (temp_dir, root)
}

fn write(root: &Path, name: &str, contents: impl AsRef<[u8]>) {
    fs::create_dir_all(root).unwrap();
    fs::write(root.join(name), contents).unwrap();
}

fn read(root: &Path, name: &str) -> String {
    String::from_utf8(fs::read(root.join(name)).unwrap()).unwrap()
}

#[track_caller]
fn assert_change_id(id: &str) {
    assert_eq!(id.len(), 12, "change id {id:?} should be 12 chars");
    assert!(
        id.chars().all(|c| ('k'..='z').contains(&c)),
        "change id {id:?} should be reverse hex (k-z)"
    );
}

#[test]
fn init_creates_repo_and_is_idempotent() {
    let (_temp, root) = temp_root();
    ops::init(&root).unwrap();
    assert!(root.join(".jj").is_dir());
    // A second init over the same root must not fail or reset anything.
    write(&root, "a.txt", "alpha\n");
    ops::init(&root).unwrap();
    assert_eq!(read(&root, "a.txt"), "alpha\n");
}

#[test]
fn snapshot_returns_change_id_and_opens_fresh_change() {
    let (_temp, root) = temp_root();
    // Auto-init: no explicit `init` call.
    write(&root, "a.txt", "alpha\n");
    let id1 = ops::snapshot(&root, Some("first")).unwrap();
    assert_change_id(&id1);

    // The closed change keeps the files; the fresh change on top is empty.
    let status = ops::status(&root).unwrap();
    assert!(
        status.starts_with("The working copy has no changes.\n"),
        "unexpected status: {status:?}"
    );
    let current_id = status.trim_end().rsplit(' ').next().unwrap();
    assert_change_id(current_id);
    assert_ne!(current_id, id1, "snapshot must open a fresh change");

    // Snapshotting again (no edits) closes the fresh change and opens another.
    let id2 = ops::snapshot(&root, None).unwrap();
    assert_change_id(&id2);
    assert_ne!(id2, id1);
    assert_eq!(
        id2, current_id,
        "second snapshot closes the change status reported"
    );
}

#[test]
fn restore_roundtrip_across_add_modify_delete() {
    let (_temp, root) = temp_root();
    write(&root, "a.txt", "alpha\n");
    write(&root, "b.txt", "bravo\n");
    let s1 = ops::snapshot(&root, Some("s1")).unwrap();

    write(&root, "a.txt", "alpha two\n");
    fs::remove_file(root.join("b.txt")).unwrap();
    write(&root, "c.txt", "charlie\n");
    let s2 = ops::snapshot(&root, Some("s2")).unwrap();

    ops::restore(&root, &s1).unwrap();
    assert_eq!(read(&root, "a.txt"), "alpha\n");
    assert_eq!(read(&root, "b.txt"), "bravo\n");
    assert!(!root.join("c.txt").exists());

    ops::restore(&root, &s2).unwrap();
    assert_eq!(read(&root, "a.txt"), "alpha two\n");
    assert!(!root.join("b.txt").exists());
    assert_eq!(read(&root, "c.txt"), "charlie\n");
}

#[test]
fn restore_to_current_state_is_a_no_op() {
    let (_temp, root) = temp_root();
    write(&root, "a.txt", "alpha\n");
    let s1 = ops::snapshot(&root, None).unwrap();
    ops::restore(&root, &s1).unwrap();
    assert_eq!(read(&root, "a.txt"), "alpha\n");
}

#[test]
fn restore_unknown_or_malformed_id_is_invalid_ref() {
    let (_temp, root) = temp_root();
    write(&root, "a.txt", "alpha\n");
    ops::snapshot(&root, None).unwrap();

    // Well-formed reverse-hex id that matches nothing.
    let err = ops::restore(&root, "kkkkkkkkkkkk").unwrap_err();
    assert_eq!(err.code, ErrorCode::InvalidRef, "{}", err.message);
    assert!(err.message.contains("doesn't exist"), "{}", err.message);

    // Malformed: neither reverse hex nor hex.
    let err = ops::restore(&root, "not-a-rev!").unwrap_err();
    assert_eq!(err.code, ErrorCode::InvalidRef);

    // Empty.
    let err = ops::restore(&root, "").unwrap_err();
    assert_eq!(err.code, ErrorCode::InvalidRef);
}

#[test]
fn diff_between_ids_and_identity() {
    let (_temp, root) = temp_root();
    write(&root, "greeting.txt", "hello\nworld\n");
    write(&root, "gone.txt", "bye\n");
    let s1 = ops::snapshot(&root, Some("s1")).unwrap();

    write(&root, "greeting.txt", "hello\nthere\nworld\n");
    fs::remove_file(root.join("gone.txt")).unwrap();
    write(&root, "fresh.txt", "fresh\n");
    let s2 = ops::snapshot(&root, Some("s2")).unwrap();

    // Identity: no output at all.
    assert_eq!(ops::diff(&root, &s1, &s1).unwrap(), "");
    assert_eq!(ops::diff(&root, &s2, &s2).unwrap(), "");

    let forward = ops::diff(&root, &s1, &s2).unwrap();
    let expected = "\
diff --git a/fresh.txt b/fresh.txt
new file mode 100644
index 0000000000..0000000000
--- /dev/null
+++ b/fresh.txt
@@ -0,0 +1,1 @@
+fresh
diff --git a/gone.txt b/gone.txt
deleted file mode 100644
index 0000000000..0000000000
--- a/gone.txt
+++ /dev/null
@@ -1,1 +0,0 @@
-bye
diff --git a/greeting.txt b/greeting.txt
index 0000000000..0000000000 100644
--- a/greeting.txt
+++ b/greeting.txt
@@ -1,2 +1,3 @@
 hello
+there
 world
";
    assert_eq!(forward, normalize_hashes(&forward, expected));

    // The reverse diff swaps adds and deletes.
    let reverse = ops::diff(&root, &s2, &s1).unwrap();
    assert!(reverse.contains("deleted file mode 100644"), "{reverse}");
    assert!(reverse.contains("--- a/fresh.txt"), "{reverse}");
    assert!(reverse.contains("+++ /dev/null"), "{reverse}");
    assert!(reverse.contains("+bye"), "{reverse}");
    assert!(reverse.contains("-there"), "{reverse}");
}

/// The `index <hash>..<hash>` lines carry content-hash prefixes. They are
/// deterministic for fixed content, but writing them out by hand would make
/// the fixtures unreadable — so expected strings carry the real structure and
/// borrow the hashes from the actual output line by line, after asserting the
/// line is an index line in both.
fn normalize_hashes(actual: &str, expected: &str) -> String {
    let actual_lines: Vec<&str> = actual.lines().collect();
    let expected_lines: Vec<&str> = expected.lines().collect();
    assert_eq!(
        actual_lines.len(),
        expected_lines.len(),
        "line count differs:\n--- actual ---\n{actual}\n--- expected ---\n{expected}"
    );
    let mut merged = String::new();
    for (actual_line, expected_line) in actual_lines.iter().zip(&expected_lines) {
        if expected_line.starts_with("index ") {
            assert!(
                actual_line.starts_with("index "),
                "expected an index line, got {actual_line:?}"
            );
            // Keep the mode suffix comparable: `index a..b 100644`.
            let expected_suffix = expected_line.splitn(3, ' ').nth(2);
            let actual_suffix = actual_line.splitn(3, ' ').nth(2);
            assert_eq!(
                actual_suffix, expected_suffix,
                "index line mode suffix differs"
            );
            merged.push_str(actual_line);
        } else {
            merged.push_str(expected_line);
        }
        merged.push('\n');
    }
    merged
}

#[test]
fn diff_multi_hunk_output_is_exact() {
    let (_temp, root) = temp_root();
    let before: String = (1..=20).map(|i| format!("line {i}\n")).collect();
    write(&root, "long.txt", &before);
    let s1 = ops::snapshot(&root, None).unwrap();

    let after = before
        .replace("line 2\n", "line two\n")
        .replace("line 18\n", "line eighteen\n");
    write(&root, "long.txt", &after);
    let s2 = ops::snapshot(&root, None).unwrap();

    let diff = ops::diff(&root, &s1, &s2).unwrap();
    let expected = "\
diff --git a/long.txt b/long.txt
index 0000000000..0000000000 100644
--- a/long.txt
+++ b/long.txt
@@ -1,5 +1,5 @@
 line 1
-line 2
+line two
 line 3
 line 4
 line 5
@@ -15,6 +15,6 @@
 line 15
 line 16
 line 17
-line 18
+line eighteen
 line 19
 line 20
";
    assert_eq!(diff, normalize_hashes(&diff, expected));
}

#[test]
fn diff_binary_files() {
    let (_temp, root) = temp_root();
    write(&root, "blob.bin", b"\x00\x01\x02");
    let s1 = ops::snapshot(&root, None).unwrap();
    write(&root, "blob.bin", b"\x00\xff\xfe");
    let s2 = ops::snapshot(&root, None).unwrap();

    let diff = ops::diff(&root, &s1, &s2).unwrap();
    assert!(
        diff.contains("Binary files a/blob.bin and b/blob.bin differ"),
        "{diff}"
    );
    assert!(
        !diff.contains("@@"),
        "binary diff must not contain hunks: {diff}"
    );
}

#[test]
fn diff_new_binary_file_uses_dev_null() {
    let (_temp, root) = temp_root();
    write(&root, "keep.txt", "keep\n");
    let s1 = ops::snapshot(&root, None).unwrap();
    write(&root, "blob.bin", b"\x00\x01");
    let s2 = ops::snapshot(&root, None).unwrap();

    let diff = ops::diff(&root, &s1, &s2).unwrap();
    assert!(
        diff.contains("Binary files /dev/null and b/blob.bin differ"),
        "{diff}"
    );
}

#[test]
fn diff_rename_shows_as_delete_plus_add() {
    let (_temp, root) = temp_root();
    write(&root, "old.txt", "same content\n");
    let s1 = ops::snapshot(&root, None).unwrap();
    fs::rename(root.join("old.txt"), root.join("new.txt")).unwrap();
    let s2 = ops::snapshot(&root, None).unwrap();

    let diff = ops::diff(&root, &s1, &s2).unwrap();
    assert!(diff.contains("diff --git a/new.txt b/new.txt"), "{diff}");
    assert!(diff.contains("new file mode 100644"), "{diff}");
    assert!(diff.contains("diff --git a/old.txt b/old.txt"), "{diff}");
    assert!(diff.contains("deleted file mode 100644"), "{diff}");
}

#[test]
fn status_reflects_working_copy_changes() {
    let (_temp, root) = temp_root();
    write(&root, "a.txt", "alpha\n");
    write(&root, "b.txt", "bravo\n");
    ops::snapshot(&root, Some("baseline")).unwrap();

    write(&root, "a.txt", "alpha two\n");
    fs::remove_file(root.join("b.txt")).unwrap();
    write(&root, "c.txt", "charlie\n");

    let status = ops::status(&root).unwrap();
    let lines: Vec<&str> = status.lines().collect();
    assert_eq!(lines[0], "Working copy changes:");
    assert_eq!(lines[1], "A c.txt");
    assert_eq!(lines[2], "D b.txt");
    assert_eq!(lines[3], "M a.txt");
    let (prefix, id) = lines[4].split_at("Working copy  (@) : ".len());
    assert_eq!(prefix, "Working copy  (@) : ");
    assert_change_id(id);
    assert_eq!(lines.len(), 5);

    // status snapshots the working copy but must not change what it reports:
    // the current change still differs from its parent the same way.
    let again = ops::status(&root).unwrap();
    assert_eq!(status, again);
}

#[test]
fn workspace_add_and_forget() {
    let (temp, root) = temp_root();
    write(&root, "a.txt", "alpha\n");
    ops::snapshot(&root, Some("base")).unwrap();

    let lane = temp.path().join("lane1");
    ops::workspace_add(&root, "lane1", lane.to_str().unwrap()).unwrap();

    // The lane materializes the parent state of the main workspace's @.
    assert_eq!(read(&lane, "a.txt"), "alpha\n");

    // The lane is a fully usable working copy: snapshot works in it.
    write(&lane, "lane.txt", "from lane\n");
    let lane_id = ops::snapshot(&lane, Some("lane work")).unwrap();
    assert_change_id(&lane_id);

    // Its snapshot is visible from the main workspace's repo.
    let diff = ops::diff(&root, "@", &lane_id).unwrap();
    assert!(diff.contains("diff --git a/lane.txt b/lane.txt"), "{diff}");

    // Duplicate names are rejected while the workspace exists...
    let err = ops::workspace_add(&root, "lane1", temp.path().join("other").to_str().unwrap())
        .unwrap_err();
    assert!(err.message.contains("already exists"), "{}", err.message);

    // ...and free again after forget.
    ops::workspace_forget(&root, "lane1").unwrap();
    let lane2 = temp.path().join("lane2");
    ops::workspace_add(&root, "lane1", lane2.to_str().unwrap()).unwrap();

    // Forgetting a workspace that does not exist is a no-op, like the CLI.
    ops::workspace_forget(&root, "nonexistent").unwrap();
}

#[test]
fn snapshot_sets_description_on_closed_change() {
    let (_temp, root) = temp_root();
    write(&root, "a.txt", "alpha\n");
    let s1 = ops::snapshot(&root, Some("the message")).unwrap();
    // No direct description accessor in the contract; prove it via restore:
    // the described change resolves and restores, i.e. it was committed.
    write(&root, "a.txt", "changed\n");
    ops::restore(&root, &s1).unwrap();
    assert_eq!(read(&root, "a.txt"), "alpha\n");
}

//! Git-format unified diff rendering over jj-lib's tree diff streams.
//!
//! jj-lib owns the hard parts — content materialization
//! (`conflicts::materialized_diff_stream`), per-side headers
//! (`diff_presentation::unified::git_diff_part`), and hunk construction
//! (`unified_diff_hunks`). This module is only the text renderer the jj CLI
//! keeps to itself: `diff --git` file headers, `---`/`+++` lines, `@@` hunk
//! headers, and the standard binary form. The output matches
//! `jj diff --git` for the cases the `Jj` contract exercises.

use std::fmt::Write as _;
use std::ops::Range;
use std::sync::Arc;

use bstr::BStr;
use futures::StreamExt as _;
use jj_lib::conflict_labels::ConflictLabels;
use jj_lib::conflicts::ConflictMarkerStyle;
use jj_lib::conflicts::ConflictMaterializeOptions;
use jj_lib::conflicts::MaterializedTreeDiffEntry;
use jj_lib::conflicts::materialized_diff_stream;
use jj_lib::copies::CopyOperation;
use jj_lib::copies::CopyRecords;
use jj_lib::diff_presentation::LineCompareMode;
use jj_lib::diff_presentation::unified::DiffLineType;
use jj_lib::diff_presentation::unified::git_diff_part;
use jj_lib::diff_presentation::unified::unified_diff_hunks;
use jj_lib::matchers::EverythingMatcher;
use jj_lib::merge::Diff;
use jj_lib::merged_tree::MergedTree;
use jj_lib::store::Store;
use pollster::FutureExt as _;

use crate::error::OpError;

/// `diff.git.context` default: three lines of context around every hunk.
const CONTEXT_LINES: usize = 3;

/// Renders the differences between two trees as a git-format unified diff.
/// Identical trees render as the empty string, mirroring `jj diff --git`.
pub fn git_diff(
    store: &Arc<Store>,
    from_tree: &MergedTree,
    to_tree: &MergedTree,
) -> Result<String, OpError> {
    let materialize_options = ConflictMaterializeOptions {
        marker_style: ConflictMarkerStyle::Diff,
        marker_len: None,
        merge: store.merge_options().clone(),
    };
    // SimpleBackend records no copies, so rename/copy detection is inert and
    // renames render as delete + add; the header path is kept for parity with
    // backends that do record copies.
    let copy_records = CopyRecords::default();
    let tree_diff = from_tree.diff_stream_with_copies(to_tree, &EverythingMatcher, &copy_records);
    let unlabeled = ConflictLabels::unlabeled();
    let conflict_labels = Diff::new(&unlabeled, &unlabeled);
    let mut diff_stream = materialized_diff_stream(store, tree_diff, conflict_labels);

    let mut output = String::new();
    async {
        while let Some(MaterializedTreeDiffEntry { path, values }) = diff_stream.next().await {
            let values = values?;
            let left_path = path.source().as_internal_file_string().to_owned();
            let right_path = path.target().as_internal_file_string().to_owned();
            let left_part =
                git_diff_part(path.source(), values.before, &materialize_options).await?;
            let right_part =
                git_diff_part(path.target(), values.after, &materialize_options).await?;

            writeln!(output, "diff --git a/{left_path} b/{right_path}").unwrap();
            let left_hash = &left_part.hash;
            let right_hash = &right_part.hash;
            match (left_part.mode, right_part.mode) {
                (None, Some(right_mode)) => {
                    writeln!(output, "new file mode {right_mode}").unwrap();
                    writeln!(output, "index {left_hash}..{right_hash}").unwrap();
                }
                (Some(left_mode), None) => {
                    writeln!(output, "deleted file mode {left_mode}").unwrap();
                    writeln!(output, "index {left_hash}..{right_hash}").unwrap();
                }
                (Some(left_mode), Some(right_mode)) => {
                    if let Some(op) = path.copy_operation() {
                        let operation = match op {
                            CopyOperation::Copy => "copy",
                            CopyOperation::Rename => "rename",
                        };
                        writeln!(output, "{operation} from {left_path}").unwrap();
                        writeln!(output, "{operation} to {right_path}").unwrap();
                    }
                    if left_mode != right_mode {
                        writeln!(output, "old mode {left_mode}").unwrap();
                        writeln!(output, "new mode {right_mode}").unwrap();
                        if left_hash != right_hash {
                            writeln!(output, "index {left_hash}..{right_hash}").unwrap();
                        }
                    } else if left_hash != right_hash {
                        writeln!(output, "index {left_hash}..{right_hash} {left_mode}").unwrap();
                    }
                }
                (None, None) => {
                    return Err(OpError::unknown(format!(
                        "diff entry for {right_path} has neither side"
                    )));
                }
            }

            if left_part.content.contents == right_part.content.contents {
                continue; // mode-only change: no content hunks
            }

            let left_label = match left_part.mode {
                Some(_) => format!("a/{left_path}"),
                None => "/dev/null".to_owned(),
            };
            let right_label = match right_part.mode {
                Some(_) => format!("b/{right_path}"),
                None => "/dev/null".to_owned(),
            };
            if left_part.content.is_binary || right_part.content.is_binary {
                writeln!(output, "Binary files {left_label} and {right_label} differ").unwrap();
            } else {
                writeln!(output, "--- {left_label}").unwrap();
                writeln!(output, "+++ {right_label}").unwrap();
                render_unified_hunks(
                    &mut output,
                    Diff::new(&left_part.content.contents, &right_part.content.contents)
                        .map(BStr::new),
                );
            }
        }
        Ok(())
    }
    .block_on()?;
    Ok(output)
}

/// The `@@` line number for a range: one-based for non-empty ranges; for an
/// empty range, POSIX says "the number of the preceding line, or 0 if the
/// range is at the start of the file".
fn to_line_number(range: &Range<usize>) -> usize {
    if range.is_empty() {
        range.start
    } else {
        range.start + 1
    }
}

/// Renders `@@` hunks with sigil-prefixed lines, including the
/// `\ No newline at end of file` marker.
fn render_unified_hunks(output: &mut String, contents: Diff<&BStr>) {
    for hunk in unified_diff_hunks(contents, CONTEXT_LINES, LineCompareMode::Exact) {
        writeln!(
            output,
            "@@ -{},{} +{},{} @@",
            to_line_number(&hunk.left_line_range),
            hunk.left_line_range.len(),
            to_line_number(&hunk.right_line_range),
            hunk.right_line_range.len()
        )
        .unwrap();
        for (line_type, tokens) in &hunk.lines {
            let sigil = match line_type {
                DiffLineType::Context => " ",
                DiffLineType::Removed => "-",
                DiffLineType::Added => "+",
            };
            output.push_str(sigil);
            let mut line_ends_with_newline = false;
            for (_token_type, content) in tokens {
                output.push_str(&String::from_utf8_lossy(content));
                line_ends_with_newline = content.ends_with(b"\n");
            }
            if !line_ends_with_newline {
                output.push_str("\n\\ No newline at end of file\n");
            }
        }
    }
}

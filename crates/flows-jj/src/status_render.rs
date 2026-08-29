//! Rendering for the `status` op.
//!
//! The format is owned by this crate (contract callers treat it as opaque
//! text) and kept deliberately small and stable: optional `A`/`M`/`D` lines
//! for the working-copy changes, then the current change id. The vocabulary
//! mirrors `jj status` so humans reading logs feel at home.

use std::fmt::Write as _;

use futures::StreamExt as _;
use jj_lib::matchers::EverythingMatcher;
use jj_lib::merged_tree::MergedTree;
use jj_lib::merged_tree::TreeDiffEntry;
use pollster::FutureExt as _;

use crate::error::OpError;

/// Renders the working-copy status: the diff of the current change against
/// its parent(s) as `A`/`M`/`D` lines, then `Working copy  (@) : <changeId>`.
pub fn status(
    parent_tree: &MergedTree,
    wc_tree: &MergedTree,
    change_id: &str,
) -> Result<String, OpError> {
    let mut lines: Vec<String> = Vec::new();
    let mut diff_stream = parent_tree.diff_stream(wc_tree, &EverythingMatcher);
    async {
        while let Some(TreeDiffEntry { path, values }) = diff_stream.next().await {
            let values = values?;
            let sigil = match (values.before.is_present(), values.after.is_present()) {
                (false, true) => 'A',
                (true, false) => 'D',
                _ => 'M',
            };
            lines.push(format!(
                "{sigil} {path}",
                path = path.as_internal_file_string()
            ));
        }
        Ok::<_, OpError>(())
    }
    .block_on()?;
    // The stream yields entries in path order already; sort defensively so
    // the format stays stable even if that changes.
    lines.sort();

    let mut output = String::new();
    if lines.is_empty() {
        writeln!(output, "The working copy has no changes.").unwrap();
    } else {
        writeln!(output, "Working copy changes:").unwrap();
        for line in &lines {
            writeln!(output, "{line}").unwrap();
        }
    }
    writeln!(output, "Working copy  (@) : {change_id}").unwrap();
    Ok(output)
}

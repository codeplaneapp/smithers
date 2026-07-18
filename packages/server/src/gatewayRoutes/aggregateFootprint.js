/** Aggregate compact per-node diff summaries without retaining patch text. */
export function aggregateFootprint(entries, { topN = 100 } = {}) {
    const byFile = new Map();
    for (const entry of Array.isArray(entries) ? entries : []) {
        if (!entry || typeof entry.nodeId !== "string" || !Number.isInteger(entry.iteration) || !Array.isArray(entry.summary?.files)) continue;
        for (const stat of entry.summary.files) {
            if (!stat || typeof stat.path !== "string" || !Number.isFinite(stat.added) || !Number.isFinite(stat.removed)) continue;
            const file = byFile.get(stat.path) ?? { path: stat.path, added: 0, removed: 0, nodes: new Set(), owner: undefined, ownerChurn: -1 };
            const churn = stat.added + stat.removed;
            file.added += stat.added;
            file.removed += stat.removed;
            file.nodes.add(`${entry.nodeId}\0${entry.iteration}`);
            // Strictly greater retains first attribution when tied.
            if (churn > file.ownerChurn) {
                file.owner = { nodeId: entry.nodeId, iteration: entry.iteration };
                file.ownerChurn = churn;
            }
            byFile.set(stat.path, file);
        }
    }
    // Modern Array#sort is stable: equal-churn files retain their first-seen
    // order, which makes the rollup easy to scan alongside its source nodes.
    const compareChurn = (left, right) => (right.added + right.removed) - (left.added + left.removed);
    const allFiles = [...byFile.values()].map((file) => ({
        path: file.path,
        added: file.added,
        removed: file.removed,
        owner: file.owner,
        nodesTouched: file.nodes.size,
    })).sort(compareChurn);
    const byDirectory = new Map();
    for (const file of allFiles) {
        const slash = file.path.lastIndexOf("/");
        const path = slash < 0 ? "." : file.path.slice(0, slash);
        const directory = byDirectory.get(path) ?? { path, files: 0, added: 0, removed: 0 };
        directory.files += 1;
        directory.added += file.added;
        directory.removed += file.removed;
        byDirectory.set(path, directory);
    }
    const directories = [...byDirectory.values()].sort(compareChurn);
    const added = allFiles.reduce((total, file) => total + file.added, 0);
    const removed = allFiles.reduce((total, file) => total + file.removed, 0);
    return {
        filesChanged: allFiles.length,
        totalFiles: allFiles.length,
        totalDirectories: directories.length,
        added,
        removed,
        directories,
        files: allFiles.slice(0, Math.max(0, topN)),
        hottestDirectory: directories[0] ?? null,
        truncated: allFiles.length > topN,
    };
}

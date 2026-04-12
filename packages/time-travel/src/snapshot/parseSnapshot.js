
/** @typedef {import("../ParsedSnapshot.ts").ParsedSnapshot} ParsedSnapshot */
/** @typedef {import("./Snapshot.ts").Snapshot} Snapshot */
/**
 * @param {Snapshot} snapshot
 * @returns {ParsedSnapshot}
 */
export function parseSnapshot(snapshot) {
    const nodesArr = JSON.parse(snapshot.nodesJson);
    const nodes = {};
    for (const n of nodesArr) {
        nodes[`${n.nodeId}::${n.iteration}`] = n;
    }
    const ralphArr = JSON.parse(snapshot.ralphJson);
    const ralph = {};
    for (const r of ralphArr) {
        ralph[r.ralphId] = r;
    }
    return {
        runId: snapshot.runId,
        frameNo: snapshot.frameNo,
        nodes,
        outputs: JSON.parse(snapshot.outputsJson),
        ralph,
        input: JSON.parse(snapshot.inputJson),
        vcsPointer: snapshot.vcsPointer,
        workflowHash: snapshot.workflowHash,
        contentHash: snapshot.contentHash,
        createdAtMs: snapshot.createdAtMs,
    };
}

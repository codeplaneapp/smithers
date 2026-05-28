/**
 * @param {string} text
 * @param {number} [maxBytes]
 * @returns {string}
 */
export function truncateToBytes(text, maxBytes) {
    if (!maxBytes || maxBytes <= 0)
        return text;
    const buf = Buffer.from(text, "utf8");
    if (buf.length <= maxBytes)
        return text;
    let end = maxBytes;
    // Back off any UTF-8 continuation bytes (0b10xxxxxx) so the slice ends on a
    // codepoint boundary, then drop the lead byte if its sequence is incomplete.
    while (end > 0 && (buf[end] & 0xc0) === 0x80)
        end--;
    if (end > 0) {
        const lead = buf[end - 1];
        let seqLen = 1;
        if ((lead & 0xe0) === 0xc0)
            seqLen = 2;
        else if ((lead & 0xf0) === 0xe0)
            seqLen = 3;
        else if ((lead & 0xf8) === 0xf0)
            seqLen = 4;
        if ((end - 1) + seqLen > maxBytes)
            end--;
    }
    return buf.subarray(0, end).toString("utf8");
}

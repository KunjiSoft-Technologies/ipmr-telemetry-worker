const toRange = (entry) => {
    if (!entry || typeof entry !== "object") return null;
    const high = Number(entry.high);
    if (!Number.isFinite(high)) return null;
    const lowRaw = entry.low === undefined ? high : Number(entry.low);
    if (!Number.isFinite(lowRaw)) return null;
    return {
        start: Math.min(high, lowRaw),
        end: Math.max(high, lowRaw)
    };
};

const countOverlapEvents = (primaryEntries, seriesEntries) => {
    const primaryRanges = (primaryEntries || []).map(toRange).filter(Boolean).sort((a, b) => a.start - b.start);
    const seriesRanges = (seriesEntries || []).map(toRange).filter(Boolean).sort((a, b) => a.start - b.start);
    let i = 0;
    let j = 0;
    let count = 0;

    while (i < primaryRanges.length && j < seriesRanges.length) {
        const p = primaryRanges[i];
        const s = seriesRanges[j];
        const overlaps = p.start <= s.end && s.start <= p.end;
        if (overlaps) {
            count += 1;
        }
        if (p.end <= s.end) i += 1;
        else j += 1;
    }

    return count;
};

module.exports = { toRange, countOverlapEvents };

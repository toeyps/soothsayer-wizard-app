/** Pearson correlation over pairwise-complete rows (both finite). `null` with fewer than 2 pairs or a zero-variance series. */
export function pearsonCorrelation(xs: number[], ys: number[]): number | null {
    const n = Math.min(xs.length, ys.length);
    let count = 0;
    let sumX = 0;
    let sumY = 0;
    for (let i = 0; i < n; i++) {
        const x = xs[i];
        const y = ys[i];
        if (Number.isFinite(x) && Number.isFinite(y)) {
            sumX += x;
            sumY += y;
            count++;
        }
    }
    if (count < 2) return null;

    const meanX = sumX / count;
    const meanY = sumY / count;
    let cov = 0;
    let varX = 0;
    let varY = 0;
    for (let i = 0; i < n; i++) {
        const x = xs[i];
        const y = ys[i];
        if (Number.isFinite(x) && Number.isFinite(y)) {
            const dx = x - meanX;
            const dy = y - meanY;
            cov += dx * dy;
            varX += dx * dx;
            varY += dy * dy;
        }
    }
    if (varX === 0 || varY === 0) return null;
    return cov / Math.sqrt(varX * varY);
}

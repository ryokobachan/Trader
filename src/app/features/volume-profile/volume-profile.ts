export type VolumeProfileBar = Readonly<{ low: number; high: number; volume: number }>;
export type VolumeProfileBin = Readonly<{ low: number; high: number; volume: number }>;
export type VolumeProfile = Readonly<{
  bins: readonly VolumeProfileBin[];
  totalVolume: number;
  pointOfControlIndex: number;
}>;

const EMPTY_PROFILE: VolumeProfile = { bins: [], totalVolume: 0, pointOfControlIndex: -1 };

/** Keep logical indices aligned with the price series, including zero-volume bars. */
export function visibleBarIndices(
  length: number,
  range: Readonly<{ from: number; to: number }> | null,
): readonly [number, number] {
  if (!range || !Number.isFinite(range.from) || !Number.isFinite(range.to)) return [0, 0];
  const start = Math.max(0, Math.ceil(range.from));
  const end = Math.min(length, Math.floor(range.to) + 1);
  return end > start ? [start, end] : [0, 0];
}

/**
 * OHLCV does not contain trades at each price. Estimate volume by distributing
 * each bar uniformly over its low–high range, in proportion to bin overlap.
 * This preserves total volume and does not infer buy/sell order flow.
 */
export function calculateVolumeProfile(
  bars: readonly VolumeProfileBar[],
  rowCount = 40,
): VolumeProfile {
  const valid = bars.filter((bar) => Number.isFinite(bar.low) && Number.isFinite(bar.high)
    && Number.isFinite(bar.volume) && bar.low > 0 && bar.high >= bar.low && bar.volume > 0);
  if (valid.length === 0) return EMPTY_PROFILE;

  let low = Infinity;
  let high = -Infinity;
  for (const bar of valid) {
    low = Math.min(low, bar.low);
    high = Math.max(high, bar.high);
  }
  const count = high === low ? 1 : Math.max(1, Math.min(200, Math.floor(rowCount) || 40));
  // Give a flat market one small, visible price band centered on its only price.
  if (high === low) {
    const padding = Math.max(low * 0.0005, 0.005);
    low -= padding;
    high += padding;
  }
  const step = (high - low) / count;
  const bins = Array.from({ length: count }, (_, index) => ({
    low: low + index * step,
    high: index === count - 1 ? high : low + (index + 1) * step,
    volume: 0,
  }));
  let totalVolume = 0;
  for (const bar of valid) {
    totalVolume += bar.volume;
    const first = Math.max(0, Math.min(count - 1, Math.floor((bar.low - low) / step)));
    const last = Math.max(first, Math.min(count - 1, Math.floor((bar.high - low) / step)));
    if (bar.high === bar.low) {
      bins[first].volume += bar.volume;
      continue;
    }
    for (let index = first; index <= last; index += 1) {
      const overlap = Math.max(0, Math.min(bar.high, bins[index].high) - Math.max(bar.low, bins[index].low));
      bins[index].volume += bar.volume * overlap / (bar.high - bar.low);
    }
  }
  const pointOfControlIndex = bins.reduce((best, bin, index) => bin.volume > bins[best].volume ? index : best, 0);
  return { bins, totalVolume, pointOfControlIndex };
}

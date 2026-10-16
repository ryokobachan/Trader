import type {
  IPrimitivePaneRenderer,
  IPrimitivePaneView,
  ISeriesPrimitive,
  SeriesAttachedParameter,
} from "lightweight-charts";
import {
  calculateVolumeProfile,
  visibleBarIndices,
  type VolumeProfile,
  type VolumeProfileBar,
} from "./volume-profile";

/** A native pane renderer keeps the profile aligned during price/time scaling. */
export class VolumeProfilePrimitive implements ISeriesPrimitive {
  private attachment: SeriesAttachedParameter | null = null;
  private bars: readonly VolumeProfileBar[] = [];
  private profile: VolumeProfile = calculateVolumeProfile([]);
  private rangeKey = "";
  private rowCount = 40;
  private color = "#6495ed";
  private readonly renderer: IPrimitivePaneRenderer = { draw: (target) => this.draw(target) };
  private readonly views: IPrimitivePaneView[] = [{
    zOrder: () => "normal",
    renderer: () => this.renderer,
  }];

  attached(attachment: SeriesAttachedParameter) {
    this.attachment = attachment;
    this.rangeKey = "";
    attachment.requestUpdate();
  }

  detached() {
    this.attachment = null;
  }

  setData(bars: readonly VolumeProfileBar[]) {
    this.bars = bars;
    this.rangeKey = "";
    this.attachment?.requestUpdate();
  }

  setOptions(options: { rowCount: number; color: string }) {
    const rowCount = Number.isFinite(options.rowCount) ? Math.max(4, Math.min(120, Math.round(options.rowCount))) : 40;
    if (rowCount === this.rowCount && options.color === this.color) return;
    this.rowCount = rowCount;
    this.color = options.color;
    this.rangeKey = "";
    this.attachment?.requestUpdate();
  }

  paneViews() {
    return this.views;
  }

  updateAllViews() {
    if (!this.attachment) return;
    const [start, end] = visibleBarIndices(this.bars.length, this.attachment.chart.timeScale().getVisibleLogicalRange());
    const key = `${start}:${end}`;
    if (key === this.rangeKey) return;
    this.rangeKey = key;
    this.profile = calculateVolumeProfile(this.bars.slice(start, end), this.rowCount);
  }

  private draw(target: Parameters<IPrimitivePaneRenderer["draw"]>[0]) {
    const series = this.attachment?.series;
    const { bins, pointOfControlIndex } = this.profile;
    if (!series || pointOfControlIndex < 0) return;
    const maxVolume = bins[pointOfControlIndex].volume;
    target.useMediaCoordinateSpace(({ context, mediaSize }) => {
      const right = mediaSize.width - 5;
      const maxWidth = Math.min(160, mediaSize.width * 0.2);
      context.save();
      context.beginPath();
      context.rect(0, 0, mediaSize.width, mediaSize.height);
      context.clip();
      bins.forEach((bin, index) => {
        if (bin.volume <= 0) return;
        const y1 = series.priceToCoordinate(bin.high);
        const y2 = series.priceToCoordinate(bin.low);
        if (y1 === null || y2 === null) return;
        const top = Math.min(y1, y2);
        const height = Math.max(1, Math.abs(y2 - y1) - 1);
        const width = Math.max(1, bin.volume / maxVolume * maxWidth);
        const isPointOfControl = index === pointOfControlIndex;
        context.globalAlpha = isPointOfControl ? 0.78 : 0.48;
        context.fillStyle = isPointOfControl ? "#eab352" : this.color;
        context.fillRect(right - width, top, width, height);
        if (isPointOfControl) {
          context.globalAlpha = 1;
          context.fillStyle = "#eab352";
          context.font = "10px -apple-system, BlinkMacSystemFont, sans-serif";
          context.textAlign = "right";
          context.textBaseline = "middle";
          context.fillText("POC", right - width - 5, top + height / 2);
        }
      });
      context.restore();
    });
  }
}

export const CHART_TEMPLATE_STORAGE_KEY = "unicorn.chart-templates.v1";
export const CHART_TEMPLATE_SCHEMA_VERSION = "unicorn.chart-templates.v1";
export const MAX_CHART_TEMPLATE_NAME_LENGTH = 60;

export const CHART_INDICATOR_IDS = [
  "sma20",
  "ema50",
  "bollinger",
  "vwap",
  "rsi14",
  "macd",
  "stochastic",
  "atr14",
  "adx14",
  "obv",
] as const;

export type ChartIndicatorId = (typeof CHART_INDICATOR_IDS)[number];

export type ChartTemplate<TSettings = unknown> = {
  id: string;
  name: string;
  activeIndicators: ChartIndicatorId[];
  hiddenIndicators: ChartIndicatorId[];
  indicatorSettings: Partial<Record<ChartIndicatorId, TSettings>>;
};

export type ChartTemplateNameError = "empty" | "too-long" | "duplicate";

type StoredChartTemplates = {
  schemaVersion: typeof CHART_TEMPLATE_SCHEMA_VERSION;
  templates: readonly ChartTemplate[];
};

const INDICATOR_ID_SET = new Set<string>(CHART_INDICATOR_IDS);

export function normalizeChartTemplateName(value: string) {
  return value.trim().replace(/\s+/g, " ");
}

export function validateChartTemplateName(
  value: string,
  existing: readonly Pick<ChartTemplate, "id" | "name">[],
  excludedId?: string,
): ChartTemplateNameError | null {
  const normalized = normalizeChartTemplateName(value);
  if (!normalized) return "empty";
  if (normalized.length > MAX_CHART_TEMPLATE_NAME_LENGTH) return "too-long";
  const duplicate = existing.some((template) => (
    template.id !== excludedId
    && normalizeChartTemplateName(template.name).localeCompare(normalized, undefined, { sensitivity: "accent" }) === 0
  ));
  return duplicate ? "duplicate" : null;
}

export function createChartTemplate<TSettings>({
  id,
  name,
  activeIndicators,
  hiddenIndicators,
  indicatorSettings,
}: ChartTemplate<TSettings>): ChartTemplate<TSettings> {
  const active = Array.from(new Set(activeIndicators.filter((item) => INDICATOR_ID_SET.has(item))));
  const activeSet = new Set(active);
  return {
    id,
    name: normalizeChartTemplateName(name),
    activeIndicators: active,
    hiddenIndicators: Array.from(new Set(hiddenIndicators.filter((item) => activeSet.has(item)))),
    indicatorSettings: Object.fromEntries(active.map((indicatorId) => [
      indicatorId,
      cloneValue(indicatorSettings[indicatorId]),
    ]).filter((entry) => entry[1] !== undefined)) as Partial<Record<ChartIndicatorId, TSettings>>,
  };
}

export function serializeChartTemplates(templates: readonly ChartTemplate[]): string {
  return JSON.stringify({
    schemaVersion: CHART_TEMPLATE_SCHEMA_VERSION,
    templates,
  } satisfies StoredChartTemplates);
}

export function parseChartTemplates(raw: string | null): ChartTemplate[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as Partial<StoredChartTemplates>;
    if (parsed.schemaVersion !== CHART_TEMPLATE_SCHEMA_VERSION || !Array.isArray(parsed.templates)) return [];
    return parsed.templates.flatMap((candidate) => {
      if (!isTemplate(candidate)) return [];
      return [createChartTemplate(candidate)];
    });
  } catch {
    return [];
  }
}

function isTemplate(value: unknown): value is ChartTemplate {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as Partial<ChartTemplate>;
  return typeof candidate.id === "string"
    && candidate.id.length > 0
    && typeof candidate.name === "string"
    && normalizeChartTemplateName(candidate.name).length > 0
    && normalizeChartTemplateName(candidate.name).length <= MAX_CHART_TEMPLATE_NAME_LENGTH
    && Array.isArray(candidate.activeIndicators)
    && candidate.activeIndicators.every((item) => INDICATOR_ID_SET.has(String(item)))
    && Array.isArray(candidate.hiddenIndicators)
    && candidate.hiddenIndicators.every((item) => INDICATOR_ID_SET.has(String(item)))
    && Boolean(candidate.indicatorSettings)
    && typeof candidate.indicatorSettings === "object"
    && !Array.isArray(candidate.indicatorSettings)
    && Object.entries(candidate.indicatorSettings).every(([indicatorId, settings]) => (
      INDICATOR_ID_SET.has(indicatorId)
      && Boolean(settings)
      && typeof settings === "object"
      && !Array.isArray(settings)
    ));
}

function cloneValue<T>(value: T): T {
  if (value === undefined) return value;
  return JSON.parse(JSON.stringify(value)) as T;
}

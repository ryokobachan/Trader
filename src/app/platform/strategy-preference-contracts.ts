export const STRATEGY_PREFERENCES_SCHEMA_VERSION =
  "trader.strategy-preferences.v1" as const;

const STRATEGY_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const CONTROL_CHARACTERS = /[\u0000-\u001F\u007F]/;

export type StrategyPreference = {
  strategyId: string;
  name?: string;
  headline?: string;
  isDeleted: boolean;
  deletedAt?: string;
  createdAt: string;
  updatedAt: string;
};

export type UpdateStrategyPreferenceInput = {
  name?: string;
  headline?: string;
};

export type StrategyPreferencesResponse = {
  schemaVersion: typeof STRATEGY_PREFERENCES_SCHEMA_VERSION;
  ownerId: string;
  preferences: StrategyPreference[];
};

export type StrategyPreferenceMutationResponse = {
  schemaVersion: typeof STRATEGY_PREFERENCES_SCHEMA_VERSION;
  preference: StrategyPreference;
};

export type StrategyPreferenceDeleteResponse =
  StrategyPreferenceMutationResponse & {
    deletedId: string;
  };

export class StrategyPreferenceInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StrategyPreferenceInputError";
  }
}

export function normalizeStrategyPreferenceId(value: unknown): string {
  if (typeof value !== "string") {
    throw new StrategyPreferenceInputError("strategyId is required");
  }
  const strategyId = value.normalize("NFKC").trim();
  if (!STRATEGY_ID_PATTERN.test(strategyId)) {
    throw new StrategyPreferenceInputError("strategyId is invalid");
  }
  return strategyId;
}

function normalizeText(value: unknown, field: "name" | "headline", maxLength: number): string {
  if (typeof value !== "string") {
    throw new StrategyPreferenceInputError(`${field} must be a string`);
  }
  const normalized = value.normalize("NFKC").trim();
  if (!normalized || normalized.length > maxLength || CONTROL_CHARACTERS.test(normalized)) {
    throw new StrategyPreferenceInputError(
      `${field} must be between 1 and ${maxLength} characters`,
    );
  }
  return normalized;
}

export function normalizeStrategyPreferenceInput(
  value: unknown,
): UpdateStrategyPreferenceInput {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new StrategyPreferenceInputError("request body must be an object");
  }
  const input = value as Record<string, unknown>;
  const keys = Object.keys(input);
  if (keys.some((key) => key !== "name" && key !== "headline")) {
    throw new StrategyPreferenceInputError("only name and headline can be edited");
  }
  const hasName = Object.prototype.hasOwnProperty.call(input, "name");
  const hasHeadline = Object.prototype.hasOwnProperty.call(input, "headline");
  if (!hasName && !hasHeadline) {
    throw new StrategyPreferenceInputError("name or headline is required");
  }

  return {
    ...(hasName ? { name: normalizeText(input.name, "name", 120) } : {}),
    ...(hasHeadline
      ? { headline: normalizeText(input.headline, "headline", 500) }
      : {}),
  };
}

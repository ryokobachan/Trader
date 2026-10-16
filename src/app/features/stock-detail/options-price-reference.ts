import type { OptionContractQuote, OptionsChainSnapshot } from "../../platform/options-contracts";

export type OptionPriceReference =
  | Readonly<{ status: "unavailable"; reason: "underlying" | "stale" | "incomplete" | "expired" | "nearby" | "quotes" }>
  | Readonly<{
      status: "available";
      strike: number;
      underlying: number;
      callMid: number;
      putMid: number;
      premium: number;
      lower: number | null;
      upper: number;
      spread: number;
    }>;

const positive = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value > 0;

function quotedMidpoint(contract: OptionContractQuote | undefined) {
  if (!contract || !positive(contract.bid) || !positive(contract.ask) || contract.bid > contract.ask) return undefined;
  return (contract.bid + contract.ask) / 2;
}

/** A hypothetical long-straddle breakeven, never a probability interval or price forecast. */
export function optionPriceReference(snapshot: OptionsChainSnapshot): OptionPriceReference {
  if (snapshot.isStale) return { status: "unavailable", reason: "stale" };
  if (!positive(snapshot.underlyingPrice)) return { status: "unavailable", reason: "underlying" };
  if (snapshot.truncated) return { status: "unavailable", reason: "incomplete" };
  if (!snapshot.expiration || snapshot.expiration < snapshot.fetchedAt.slice(0, 10)) return { status: "unavailable", reason: "expired" };
  const underlying = snapshot.underlyingPrice;
  const contracts = snapshot.contracts.filter(contract => contract.expiration === snapshot.expiration && positive(contract.strike));
  const strikes = [...new Set(contracts.map(contract => contract.strike))].sort((a, b) => Math.abs(a - underlying) - Math.abs(b - underlying) || a - b);
  const strike = strikes[0];
  // A remote strike must not silently stand in for an at-the-money contract.
  if (strike === undefined || Math.abs(strike - underlying) / underlying > 0.05) return { status: "unavailable", reason: "nearby" };
  const calls = contracts.filter(contract => contract.strike === strike && contract.side === "call");
  const puts = contracts.filter(contract => contract.strike === strike && contract.side === "put");
  const call = calls.length === 1 ? calls[0] : undefined;
  const put = puts.length === 1 ? puts[0] : undefined;
  const callMid = quotedMidpoint(call);
  const putMid = quotedMidpoint(put);
  if (callMid === undefined || putMid === undefined || !call || !put) return { status: "unavailable", reason: "quotes" };
  const premium = callMid + putMid;
  const spread = (call.ask! - call.bid!) + (put.ask! - put.bid!);
  return {
    status: "available", strike, underlying, callMid, putMid, premium,
    lower: strike - premium >= 0 ? strike - premium : null,
    upper: strike + premium, spread,
  };
}

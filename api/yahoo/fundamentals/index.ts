import { YAHOO_BALANCE_SHEET_TYPES } from "./bs";
import { YAHOO_CASH_FLOW_TYPES } from "./cash-flow";
import { YAHOO_INCOME_STATEMENT_TYPES } from "./income";
import { YAHOO_VALUATION_TYPES } from "./valuation";

export const YAHOO_TIMESERIES_URL =
  "https://query2.finance.yahoo.com/ws/fundamentals-timeseries/v1/finance/timeseries";

// Preserve the reviewed request batches while keeping each financial statement
// field list independently editable.
export const YAHOO_FUNDAMENTAL_TYPE_BATCHES = Object.freeze([
  Object.freeze([
    ...YAHOO_INCOME_STATEMENT_TYPES,
    YAHOO_CASH_FLOW_TYPES[0],
  ]),
  YAHOO_VALUATION_TYPES,
  Object.freeze([
    ...YAHOO_CASH_FLOW_TYPES.slice(1),
    ...YAHOO_BALANCE_SHEET_TYPES,
  ]),
]);

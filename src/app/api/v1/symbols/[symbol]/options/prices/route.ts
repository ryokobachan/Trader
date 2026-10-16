import { createOptionPriceHistoryClient } from "@api/options/price-history.server";
import { createChartExchangeOptionHistoryClient } from "@api/options/chartexchange-history.server";
import { createOptionsPriceHistoryRoute } from "@api/options/price-history-route.server";

export const GET = createOptionsPriceHistoryRoute({
  chartexchange: createChartExchangeOptionHistoryClient(),
  yahoo: createOptionPriceHistoryClient(),
});

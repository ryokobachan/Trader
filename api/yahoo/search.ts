/** Yahoo Search endpoint used for U.S. instrument search and company news. */
export const YAHOO_SEARCH_URL = "https://query1.finance.yahoo.com/v1/finance/search";

export const POPULAR_US_SYMBOLS = Object.freeze([
  "AAPL",
  "MSFT",
  "NVDA",
  "AMZN",
  "GOOGL",
  "META",
  "TSLA",
  "BRK-B",
  "PLTR",
  "JPM",
]);

export const US_EXCHANGES = Object.freeze({
  NMS: { name: "NASDAQ Global Select Market", mic: "XNAS" },
  NGM: { name: "NASDAQ Global Market", mic: "XNAS" },
  NCM: { name: "NASDAQ Capital Market", mic: "XNAS" },
  NYQ: { name: "New York Stock Exchange", mic: "XNYS" },
  ASE: { name: "NYSE American", mic: "XASE" },
  PCX: { name: "NYSE Arca", mic: "ARCX" },
  BTS: { name: "Cboe BZX", mic: "BATS" },
});

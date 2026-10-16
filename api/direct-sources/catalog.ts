import type { DirectSourceDefinition } from "../../src/app/platform/direct-source-contracts";

export const FRED_SERIES = Object.freeze([
  { id: "FEDFUNDS", label: "Fed funds rate", labelJa: "政策金利" },
  { id: "DGS2", label: "2-year Treasury yield", labelJa: "米国債2年利回り" },
  { id: "DGS10", label: "10-year Treasury yield", labelJa: "米国債10年利回り" },
  { id: "T10Y2Y", label: "10Y–2Y Treasury spread", labelJa: "長短金利差（10年−2年）" },
  { id: "CPIAUCSL", label: "Consumer price index", labelJa: "消費者物価指数" },
  { id: "PCEPILFE", label: "Core PCE price index", labelJa: "コアPCE物価指数" },
  { id: "UNRATE", label: "Unemployment rate", labelJa: "失業率" },
  { id: "VIXCLS", label: "VIX close", labelJa: "VIX終値" },
  { id: "BAMLH0A0HYM2", label: "High-yield option-adjusted spread", labelJa: "ハイイールド債スプレッド" },
]);

export const DIRECT_SOURCES: readonly DirectSourceDefinition[] = Object.freeze([
  { id: "sec-filings", name: "SEC filings", nameJa: "SEC 企業開示", description: "Recent filings and links to the original documents.", descriptionJa: "最近の提出書類と原文へのリンク。提出日と対象期間を確認できます。", sourceUrl: "https://www.sec.gov/search-filings", inputs: ["symbol", "date"], defaults: { symbol: "AAPL" }, credential: "SEC_EDGAR_USER_AGENT" },
  { id: "sec-facts", name: "SEC financial facts", nameJa: "SEC 財務原票", description: "Reported XBRL facts, with units, periods, and filing dates.", descriptionJa: "XBRL財務値を単位・対象期間・提出日付きで表示します。", sourceUrl: "https://www.sec.gov/search-filings/edgar-application-programming-interfaces", inputs: ["symbol", "date"], defaults: { symbol: "AAPL" }, credential: "SEC_EDGAR_USER_AGENT" },
  { id: "sec-insiders", name: "SEC insider transactions", nameJa: "SEC インサイダー取引", description: "Non-derivative transactions from recent Form 4 filings.", descriptionJa: "最近のForm 4から、株式などの非デリバティブ取引明細を取得します。", sourceUrl: "https://www.sec.gov/search-filings", inputs: ["symbol", "date"], defaults: { symbol: "AAPL" }, credential: "SEC_EDGAR_USER_AGENT" },
  { id: "finra-short-volume", name: "FINRA short sale volume", nameJa: "FINRA 空売り出来高", description: "Daily consolidated off-exchange short sale volume by symbol.", descriptionJa: "銘柄・日付を指定して、取引所外の報告分における空売り出来高を取得します。空売り残高とは異なります。", sourceUrl: "https://www.finra.org/finra-data/browse-catalog/short-sale-volume-data", inputs: ["symbol", "date"], defaults: { symbol: "AAPL" }, credential: null },
  { id: "usaspending", name: "USAspending contracts", nameJa: "米政府契約", description: "Search federal contract awards by recipient name.", descriptionJa: "受取企業名で米政府契約を検索します。関連企業を含む原文の企業名を表示します。", sourceUrl: "https://www.usaspending.gov/", inputs: ["recipient"], defaults: { recipient: "LOCKHEED MARTIN" }, credential: null },
  { id: "fred", name: "FRED macro indicators", nameJa: "FRED マクロ指標", description: "Rates, inflation, employment, and credit conditions, including vintage selection.", descriptionJa: "金利・物価・雇用・信用指標。過去の日付を指定すると、その時点の公表値を取得します。", sourceUrl: "https://fred.stlouisfed.org/", inputs: ["series", "date"], defaults: { series: "DGS10" }, credential: "FRED_API_KEY" },
  { id: "cnn-fear-greed", name: "CNN Fear & Greed", nameJa: "CNN Fear & Greed", description: "Market sentiment snapshot and previous reference values.", descriptionJa: "市場心理スコアと前回・過去の参考値。取得元の更新時刻を表示します。", sourceUrl: "https://www.cnn.com/markets/fear-and-greed", inputs: [], defaults: {}, credential: null },
]);

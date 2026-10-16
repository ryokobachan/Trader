/** Explicit allowlists: adding a dataset never silently exposes it to an MCP. */
export const MCP_SERVERS = {
  market: {
    folder: "trader-market",
    name: "trader-market", title: "Trader Market",
    description: "Market prices, company research, technicals, options and public economic data.",
    tools: {
      get_quote: "quote", get_ohlcv: "bars", get_stock_overview: "workspace",
      get_company_profile: "profile", get_fundamentals: "fundamentals",
      get_financials: "financials", get_earnings: "earnings",
      get_analyst_consensus: "analyst", get_analyst_ratings: "analyst-ratings",
      get_news: "news", get_research: "research", get_corporate_actions: "corporate-actions",
      list_technical_indicators: "technical-indicators", get_technicals: "technicals",
      get_options_chain: "options-chain", get_options_history: "options-history",
      get_sec_filings: "sec-filings", get_sec_facts: "sec-facts", get_insider_transactions: "sec-insiders",
      get_short_volume: "finra-short-volume", get_government_contracts: "usaspending",
      get_economic_data: "fred", get_fear_greed_index: "cnn-fear-greed",
    },
    statusDataset: "source-status",
  },
  "13f": {
    folder: "finance-13f",
    name: "trader-13f", title: "13F",
    description: "Published institution directories, SEC 13F filings and filing-level holdings from the independent finance store.",
    tools: {
      list_institutional_managers: "institutional-managers",
      get_institutional_filings: "institutional-filings",
      get_institutional_holdings: "institutional-holdings",
    },
    statusDataset: "institutional-filings",
  },
  "x-finance": {
    folder: "x-finance",
    name: "trader-x-finance", title: "X Finance",
    description: "Stored X posts, mentions, author analysis and prices from the independent X finance store. Does not collect new posts.",
    tools: {
      list_x_accounts: "x-accounts", get_x_posts: "x-posts", get_x_mentions: "x-mentions",
      get_x_mention_outcomes: "x-mention-outcomes", get_x_author_scores: "x-author-scores",
      get_x_author_strategies: "x-author-strategies", get_x_prices: "x-prices",
    },
    statusDataset: "x-posts",
  },
  strategy: {
    folder: "trader-strategy",
    name: "trader-strategy", title: "Trader Strategy",
    description: "Read saved Trader strategies, results and trade ledgers for the local owner. Does not run backtests or place trades.",
    tools: {
      list_strategies: "strategy-list", get_strategy: "strategy",
      get_strategy_performance: "strategy-performance", get_strategy_equity: "strategy-equity",
      get_strategy_holdings: "strategy-holdings", get_strategy_transactions: "strategy-transactions",
    },
    statusDataset: "strategy-list",
  },
} as const;

export type McpServerId = keyof typeof MCP_SERVERS;

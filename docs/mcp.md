# Trader MCP

読み取り専用MCPを4フォルダに分けています。配布物はすべてテキストです。

| フォルダ | 用途 | 動作環境 |
|---|---|---|
| [trader-market](../mcp/trader-market/README.md) | 株価・企業情報・財務・ニュースなど | Trader不要。別Macでも利用可能 |
| [finance-13f](../mcp/finance-13f/README.md) | 機関投資家・13F・保有情報 | このMacのTrader |
| [x-finance](../mcp/x-finance/README.md) | 保存済みX投稿・分析結果 | このMacのTrader |
| [trader-strategy](../mcp/trader-strategy/README.md) | 保存済み戦略・成績・売買履歴 | このMacのTrader |

## ファイル構成

```text
trader-market/
├── server.mjs
├── README.md
├── tools.yaml
├── LICENSES.txt
└── src/
    ├── market.py
    ├── sidecar.py
    ├── financial_history.py
    ├── talib_indicators.py
    └── requirements.txt
```

他の3 MCPは `server.mjs`・`tools.yaml`・`README.md`・`LICENSES.txt` のみです。
`tools.yaml`は公開する名前・日本語の説明・入出力の編集元です。起動時に読み込むため、編集後はMCPを再接続してください。
`dataset`は実装済みの取得処理を指します。新しい処理・引数の追加にはコードの変更が必要です。取得元の必須条件・上限は維持します。
ライセンスは原文を保持します。実行環境・資格情報・保存データは同梱しません。

## 利用方法

各フォルダのREADMEをCodexに渡し、セットアップとMCP登録を依頼してください。
利用者自身のターミナル操作は不要です。Codexが起動・終了を管理します。
設定先は通常 `~/.codex/config.toml` です。MCPフォルダ内に専用の `codex.toml` は置きません。
詳しくは[OpenAI公式ドキュメント](https://developers.openai.com/ja-JP/docs/extend/mcp)を参照してください。

MarketにはNode.js 22.13.0以上・Python 3.10以上が必要です。
`server.mjs --setup` でPythonライブラリを `~/.cache/trader-market/python` に導入します。
取得・計算用のPython処理も同梱しており、既存Traderには接続しません。

## データの扱い

各ツールの`outputSchema`は成功時の`structuredContent`を定義し、MCPのツール一覧にも公開します。
必須項目や型が合わない結果はエラーになります。`isError: true`のエラー応答はこのスキーマの対象外です。
同じ返却形式はYAMLアンカーで共有します。列が可変のデータは`columns`で列を確認してください。

- 出典・欠損・警告・公開版・ページ情報を保持します。部分データを完全なデータとみなしません。
- 空ページでもnextCursorがあれば続けます。公開版変更時は最初から取得し直します。
- `asOf`は保存されている版の絞り込みで、上書き済みの過去データは復元しません。
- `get_status`はMarketでは設定確認、他3つでは保存データの読み取り確認です。鮮度・完全性は保証しません。
- 結果は8 MiBまで。超過時は切り捨てずエラーにします。
- 収集・DB修復・戦略実行・注文の機能はありません。

## 開発・更新

ツール定義は各MCPの `tools.yaml` を直接編集します。ビルドでは上書きしません。
取得処理の編集元は `src/tooling/mcp/` と `api/`、生成処理は `src/tooling/scripts/build-mcp.ts` です。
生成済みの配布ファイルを直接編集せず、編集元を修正します。

```sh
npm run mcp:build
npm run mcp:check
npm run test:mcp
```

テストはツールの入力契約、コピー先での起動、Traderに接続しないMarketの取得処理を確認します。
Python依存を導入済みならTA-Libと補助プロセスの終了も検証します。未導入時はその統合テストだけスキップします。
配布時はフォルダごと置き換え、MCPを再接続してください。

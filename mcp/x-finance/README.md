# X Finance MCP

このMacのTraderから、保存済みX投稿・銘柄言及・分析結果を読みます。
読み取り専用です。出典・欠損・警告を保持し、収集・注文・戦略実行は行いません。

## 使い方

必要環境：Node.js 22.13以上と、このMacで起動済みのTrader。
このREADMEをCodexに渡し、「このMCPを登録して」と依頼してください。

- 登録名：`trader-x-finance`
- 接続方式：STDIO
- コマンド：Node.jsの実行ファイル
- 引数：このフォルダの `server.mjs` の絶対パス

Codexの設定先は通常 `~/.codex/config.toml` です。登録後にMCPを再接続してください。
起動・終了はCodexが管理します。利用者自身のターミナル操作は不要です。

## 構成

- `server.mjs`：MCP本体。npmインストール不要。
- `tools.yaml`：公開ツールの名前・説明・入出力の定義。
- `README.md`：使い方。
- `LICENSES.txt`：ライセンス原文。

## 設定

CodexのMCP環境変数に指定します。

- `TRADER_BASE_URL`：既定 `http://127.0.0.1:3001`。このMacのループバック接続のみ。

- `TRADER_MCP_TIMEOUT_MS`：取得タイムアウト。既定60000、最大120000ミリ秒。

## ツール

公開する8ツールの詳細は [tools.yaml](tools.yaml) にまとめています。
起動時に読み込みます。名前・日本語の説明・入出力の定義を編集し、MCPを再接続すると反映されます。
`dataset`は実装済みの取得処理に対応します。新しい取得処理や未対応の引数を追加する場合はコードの変更も必要です。
取得元の必須条件・上限はYAMLで緩めても変わりません。
`outputSchema`は成功時の返却データ（structuredContent）の形式です。型が合わない結果はエラーにします。`isError: true`のエラー応答は対象外です。
同じ返却形式はYAMLアンカー（`&名前`・`*名前`）で共有します。null・空配列・追加の出典情報は保持します。

空ページでもnextCursorがあれば続けます。公開版が変わった場合は取得し直してください。

## 更新

フォルダごと置き換え、MCPを再接続します。資格情報は共有フォルダに含めないでください。
`tools.yaml`は直接編集でき、ビルドでも上書きしません。
取得処理の開発時はTraderリポジトリの `src/tooling/mcp/` と `api/` を修正し、`npm run mcp:build`・`npm run test:mcp` を実行します。`server.mjs`と`src/`は生成物です。

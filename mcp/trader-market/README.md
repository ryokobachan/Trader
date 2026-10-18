# Trader Market MCP

株価・企業情報・財務・ニュース・テクニカル・オプション・公的データを取得します。Trader不要で、別のMacでも使えます。
読み取り専用です。出典・欠損・警告を保持し、収集・注文・戦略実行は行いません。

## 使い方

必要環境：Node.js 22.13以上、Python 3.10以上、インターネット接続。
このREADMEをCodexに渡し、「実行環境を確認し、server.mjs --setupを実行してMCP登録して」と依頼してください。
Pythonライブラリは `~/.cache/trader-market/python` に入り、このフォルダには追加されません。

- 登録名：`trader-market`
- 接続方式：STDIO
- コマンド：Node.jsの実行ファイル
- 引数：このフォルダの `server.mjs` の絶対パス

Codexの設定先は通常 `~/.codex/config.toml` です。登録後にMCPを再接続してください。
起動・終了はCodexが管理します。利用者自身のターミナル操作は不要です。

## 構成

- `server.mjs`：MCP本体。npmインストール不要。
- `tools.yaml`：公開ツールの名前・説明・入出力の定義。
- `src/`：Python処理と必要ライブラリの一覧。
- `README.md`：使い方。
- `LICENSES.txt`：ライセンス原文。

## 設定

CodexのMCP環境変数に指定します。

- `SEC_EDGAR_USER_AGENT`：SEC用の氏名・連絡先。
- `FRED_API_KEY`：FRED用APIキー。
- `BENZINGA_API_TOKEN` または `BENZINGA_API_KEY`：Benzinga用。未設定時は取得範囲が限定されます。
- `MARKET_PYTHON`：必要ライブラリを導入済みのPythonを使う場合、その絶対パス。

株価・財務は外部マーケットデータ、企業情報・ニュースはYahoo、決算はGoogle Finance、アナリストはGoogle Finance・Benzingaを使用します。
個人のローカル利用向けです。各取得元の利用条件・認証・取得制限が適用されます。

- `TRADER_MCP_TIMEOUT_MS`：取得タイムアウト。既定60000、最大120000ミリ秒。

## ツール

公開する24ツールの詳細は [tools.yaml](tools.yaml) にまとめています。
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

import { readFile, mkdir, writeFile, chmod, rm, rmdir } from "node:fs/promises";
import { builtinModules } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { MCP_SERVERS } from "../mcp/servers";

import { readToolDefinitions } from "../mcp/definitions";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const check = process.argv.slice(2).length === 1 && process.argv[2] === "--check";
if (process.argv.length > 2 && !check) throw new Error("Only --check is supported.");
const builtins = new Set(builtinModules.flatMap(name => [name, `node:${name}`]));
const notices = (await Promise.all(["LICENSE", "node_modules/@modelcontextprotocol/server/LICENSE", "node_modules/@modelcontextprotocol/core/LICENSE", "node_modules/zod/LICENSE", "node_modules/js-yaml/LICENSE"].map(async file => `===== ${file.replace("node_modules/", "")} =====\n${await readFile(path.join(root, file), "utf8")}`))).join("\n\n");
const stale: string[] = [];

for (const [id, config] of Object.entries(MCP_SERVERS)) {
  const folder = path.join(root, "mcp", config.folder);
  const definitions = readToolDefinitions(id as keyof typeof MCP_SERVERS, path.join(folder, "tools.yaml"));
  const output = await build({
    absWorkingDir: root,
    stdin: { contents: id === "market" ? `import { startMarketMcp } from "./src/tooling/mcp/market-cli.ts";\nawait startMarketMcp();` : `import { startMcpServer } from "./src/tooling/mcp/cli.ts";\nawait startMcpServer(${JSON.stringify(id)});`, resolveDir: root, sourcefile: `${config.folder}.ts`, loader: "ts" },
    bundle: true, platform: "node", format: "esm", target: "node22", write: false,
    sourcemap: false, minify: false, legalComments: "inline", metafile: true,
    banner: { js: "// npm run mcp:build による生成物。src/tooling/mcp を修正して再生成してください。\n// 依存ライブラリ同梱。Node.js 22.13.0以上が必要です。\nimport { createRequire as mcpCreateRequire } from 'node:module';\nconst require = mcpCreateRequire(import.meta.url);" },
  });
  const external = Object.values(output.metafile.outputs).flatMap(item => item.imports).filter(item => item.external && !builtins.has(item.path));
  if (external.length) throw new Error(`Unbundled dependencies in ${id}: ${external.map(item => item.path).join(", ")}`);
  const summaries: Record<string, string> = {
    market: "株価・企業情報・財務・ニュース・テクニカル・オプション・公的データを取得します。Trader不要で、別のMacでも使えます。",
    "13f": "このMacのTraderから、機関投資家・13F提出・保有情報を読みます。",
    "x-finance": "このMacのTraderから、保存済みX投稿・銘柄言及・分析結果を読みます。",
    strategy: "このMacのTraderから、保存済み戦略・成績・保有・売買履歴を読みます。",
  };
  const readme = `# ${config.title} MCP

${summaries[id]}
読み取り専用です。出典・欠損・警告を保持し、収集・注文・戦略実行は行いません。

## 使い方

${id === "market" ? "必要環境：Node.js 22.13以上、Python 3.10以上、インターネット接続。\nこのREADMEをCodexに渡し、「実行環境を確認し、server.mjs --setupを実行してMCP登録して」と依頼してください。\nPythonライブラリは `~/.cache/trader-market/python` に入り、このフォルダには追加されません。" : "必要環境：Node.js 22.13以上と、このMacで起動済みのTrader。\nこのREADMEをCodexに渡し、「このMCPを登録して」と依頼してください。"}

- 登録名：\`${config.name}\`
- 接続方式：STDIO
- コマンド：Node.jsの実行ファイル
- 引数：このフォルダの \`server.mjs\` の絶対パス

Codexの設定先は通常 \`~/.codex/config.toml\` です。登録後にMCPを再接続してください。
起動・終了はCodexが管理します。利用者自身のターミナル操作は不要です。

## 構成

- \`server.mjs\`：MCP本体。npmインストール不要。
- \`tools.yaml\`：公開ツールの名前・説明・入出力の定義。
${id === "market" ? "- `src/`：Python処理と必要ライブラリの一覧。\n" : ""}- \`README.md\`：使い方。
- \`LICENSES.txt\`：ライセンス原文。

## 設定

CodexのMCP環境変数に指定します。
${id === "market" ? `
- \`SEC_EDGAR_USER_AGENT\`：SEC用の氏名・連絡先。
- \`FRED_API_KEY\`：FRED用APIキー。
- \`BENZINGA_API_TOKEN\` または \`BENZINGA_API_KEY\`：Benzinga用。未設定時は取得範囲が限定されます。
- \`MARKET_PYTHON\`：必要ライブラリを導入済みのPythonを使う場合、その絶対パス。

株価・財務はTradingView、企業情報・ニュースはYahoo、決算はGoogle Finance、アナリストはGoogle Finance・Benzingaを使用します。
個人のローカル利用向けです。各取得元の利用条件・認証・取得制限が適用されます。
` : "\n- `TRADER_BASE_URL`：既定 `http://127.0.0.1:3001`。このMacのループバック接続のみ。\n"}
- \`TRADER_MCP_TIMEOUT_MS\`：取得タイムアウト。既定60000、最大120000ミリ秒。

## ツール

公開する${definitions.length}ツールの詳細は [tools.yaml](tools.yaml) にまとめています。
起動時に読み込みます。名前・日本語の説明・入出力の定義を編集し、MCPを再接続すると反映されます。
\`dataset\`は実装済みの取得処理に対応します。新しい取得処理や未対応の引数を追加する場合はコードの変更も必要です。
取得元の必須条件・上限はYAMLで緩めても変わりません。
\`outputSchema\`は成功時の返却データ（structuredContent）の形式です。型が合わない結果はエラーにします。\`isError: true\`のエラー応答は対象外です。
同じ返却形式はYAMLアンカー（\`&名前\`・\`*名前\`）で共有します。null・空配列・追加の出典情報は保持します。

空ページでもnextCursorがあれば続けます。公開版が変わった場合は取得し直してください。

## 更新

フォルダごと置き換え、MCPを再接続します。資格情報は共有フォルダに含めないでください。
\`tools.yaml\`は直接編集でき、ビルドでも上書きしません。
取得処理の開発時はTraderリポジトリの \`src/tooling/mcp/\` と \`api/\` を修正し、\`npm run mcp:build\`・\`npm run test:mcp\` を実行します。\`server.mjs\`と\`src/\`は生成物です。
`;
  const files: Record<string, string> = { "server.mjs": output.outputFiles[0].text, "README.md": readme, "LICENSES.txt": notices };
  if (id === "market") {
    for (const name of ["sidecar.py", "financial_history.py", "talib_indicators.py", "requirements.txt"]) files[`src/${name}`] = await readFile(path.join(root, "api/tradingview-websocket", name), "utf8");
    files["src/market.py"] = await readFile(path.join(root, "src/tooling/mcp/market.py"), "utf8");
  }
  // Remove only the obsolete generated registration example; this was never a Codex config location.
  const obsolete = ["codex.toml", "tools.toml", ...(id === "market" ? ["market.py", "sidecar.py", "financial_history.py", "talib_indicators.py", "requirements.txt"].flatMap(name => [name, `python/${name}`]) : [])];
  for (const name of obsolete) {
    const legacy = path.join(folder, name);
    if (check) { if (await readFile(legacy).then(() => true, () => false)) stale.push(path.relative(root, legacy)); }
    else await rm(legacy, { force: true });
  }
  if (!check && id === "market") await rmdir(path.join(folder, "python")).catch(error => { if (!["ENOENT", "ENOTEMPTY"].includes(error.code)) throw error; });
  for (const [name, content] of Object.entries(files)) {
    const destination = path.join(folder, name);
    if (check) {
      const actual = await readFile(destination, "utf8").catch(() => null);
      if (actual !== content) stale.push(path.relative(root, destination));
    } else {
      await mkdir(path.dirname(destination), { recursive: true });
      await writeFile(destination, content, { mode: 0o644 });
      await chmod(destination, 0o644);
    }
  }
}
if (stale.length) { process.stderr.write(`MCP files need regeneration: ${stale.join(", ")}\n`); process.exitCode = 1; }
else process.stdout.write(check ? "MCP text files are up to date.\n" : "Built four text-only MCP folders: standalone Market and three local clients.\n");

# Trusted UI Module Registry

- Version: `trader.ui-module.v1`
- Status: `chart.symbol-summary` implemented; other declared surfaces reserved
- Scope: developer-installed frontend modules
- Project overview: [README](../../README.md)

## 1. Purpose

Traderの画面に表示する項目を、巨大なCore componentへ追加し続けないための契約である。開発者は銘柄概要等のmoduleを追加でき、OperatorとWorkspace Userは導入済みmoduleの範囲内で表示を構成できる。

UI Moduleは **trusted build-time extension** である。Provider pluginがUIを注入する仕組み、remote URLからのJavaScript取得、End userによるcode uploadを意味しない。

## 2. Extension types

| Extension | 実行場所 | 提供するもの | UI code |
|---|---|---|---|
| Data Provider | Server／worker | canonical data、capability、provenance | 不可 |
| Indicator | Server／worker | definition、canonical calculation、render manifest | 不可 |
| UI Module | Browser／SSR bundle | canonical dataの表示component | trusted buildのみ可 |
| Theme | Browser／SSR bundle | semantic design token | trusted buildのみ可 |

Core Themeは`type-base`、`type-secondary`、`type-micro`、`type-numeric`等のsemantic tokenを公開する。moduleは可読性を損なう独自の極小文字サイズではなくこのtokenを使い、標準日本語UIでは10pxを下限とする。

ProviderとUI Moduleは別package、別Registryとする。特定Providerが必要なmoduleも、Provider固有DTOを直接受け取らず、`requiredCapabilities`とcanonical metric IDを宣言する。

## 3. Manifest contract

serializable manifestと実行可能なReact componentを分離する。

```ts
type UiSurface =
  | "chart.symbol-summary"
  | "symbol.detail"
  | "strategy.table-column";

type UiModuleManifestV1 = {
  schemaVersion: "trader.ui-module.v1";
  id: `${string}.${string}`;
  version: string;
  surface: UiSurface;
  label: string;
  description: string;
  requiredCapabilities: string[];
  defaultEnabled: boolean;
  defaultOrder: number;
  userConfigurable: boolean;
  supportedDensities?: Array<"compact" | "normal">;
};

type UiModuleRegistration = {
  manifest: UiModuleManifestV1;
  Component: React.ComponentType<SymbolSummaryModuleProps>;
};
```

Rules:

- `id`は`core.*`または開発者が所有するnamespaceを使い、表示名やlocaleを含めない
- 保存設定は`id@exact-version`を使用する。compatible updateでもmigrationを明示する
- `label`／`description`は既定copy。Core moduleの英日表示はCoreの翻訳adapterが上書きし、custom moduleの翻訳はmodule自身が所有する
- 現v1で実際にhostされるsurfaceは`chart.symbol-summary`のみ。その他のsurface値は将来hostとの互換予約である
- config entryの`settings`はRegistryがplain objectとして保持するが、現在のsummary hostはcomponentへ渡さない。設定schemaとprops配線が実装されるまで利用しない
- 同じ`id@version`の二重登録、未知schema version、未対応surfaceは起動時に拒否する

## 4. Registration and loading

Core Skeleton v0ではdynamic package discoveryを行わない。開発者が依存packageをinstallし、deployment-owned Composition Rootへ明示的にimportする。

```ts
// extensions/index.ts
import { CORE_SYMBOL_SUMMARY_MODULES } from "@/app/features/symbol-summary/core-modules";
import { defineUiModuleRegistry } from "@/app/platform/ui-module-registry";
import { marketContextModule } from "./market-context";

export const TRADER_UI_MODULE_REGISTRY = defineUiModuleRegistry([
  ...CORE_SYMBOL_SUMMARY_MODULES,
  marketContextModule,
]);
```

非secretな`api/config.json`は、このbundleへ登録済みのIDからenable／orderを選ぶだけである。JSON内のpackage名から自動installしたり、component path、remote URL、raw HTMLを読み込んだりしない。

起動時にRegistryは次を検証する。

1. manifest schemaとCore API version
2. namespace、ID、versionの一意性
3. surfaceとrequired capability
4. configのmodule ID、enabled/order、plain-object settings

不正なmoduleは黙ってfallbackせず、起動またはconfig validationを失敗させる。credential値や内部filesystem pathは診断へ含めない。

## 5. Data and render contract

現在の`chart.symbol-summary` componentはProvider固有responseではなく、Coreが組み立てたsummary modelを受け取る。

```ts
type SymbolSummaryModuleProps = {
  stock: SymbolSummaryStock;
  intelligence: SymbolSummaryIntelligence;
  afterHours?: SyntheticLatestClose;
  watched: boolean;
  onToggleWatched: () => void;
  density: "compact" | "normal";
};
```

- componentはこのCore modelだけを描画し、Provider response shapeを参照しない
- loading／missing／stale等の状態はCore host/serviceでcanonical modelへ変換する
- moduleはProvider credential、SecretStore、App DB client、任意network requestを受け取らない
- mutationが必要なmoduleはCore action contractを使い、直接storageへ書き込まない

## 6. Core-owned invariants

UI Moduleから変更できないもの:

- App Shell、route、認証／認可、Workspace境界
- canonical DTO、metric unit、Instrument ID、Universe Policy
- provenance、PIT、共通error contract、secret masking
- keyboard／focus、WCAG、locale／timezoneの最低要件
- third-party attributionとlicense表示
- CSP、remote code禁止、package allow-list

Theme extensionは背景色等のsemantic tokenを変更できるが、token名、focus可視性、状態色を色だけに依存させない規則は変更できない。UI ModuleのstyleはCSS Modules等でscopeし、Coreのglobal selectorを上書きしない。

## 7. Configuration precedence

1. Module manifest: capability、surface、default visibility/order
2. Operator config: bundle済みpackage／moduleのallow-listとdefault order
3. `api/config.json`: 許可済みmoduleの表示順と密度
4. User session: summary設定menuの一時的な表示／非表示

下位層は上位層の許可範囲を広げられない。未知moduleや未検証settingsは実行しない。

## 8. Default chart summary profile

Core Skeletonの初期profile:

```text
core.identity_quote@1.0.0
core.price_range@1.0.0
core.key_statistics@1.0.0
core.earnings@1.0.0
core.financials@1.0.0
core.performance@1.0.0
core.technical_rating@1.0.0
core.analyst_consensus@1.0.0
core.company_profile@1.0.0
```

これはdefaultであり固定画面ではない。利用者は導入済みmoduleの範囲で表示と順序を変更し、開発者は別namespaceのmoduleを追加できる。チャート画面末尾のCore-owned `詳細` CTAはmodule化しない。

## 9. Example extension layout

```text
extensions/example-market-context/
  manifest.ts
  MarketContextModule.tsx
  MarketContextModule.test.tsx
  README.md
extensions/index.ts
```

Developer workflow:

1. manifestとcomponentを実装する
2. Core primitiveだけを使ったcomponent／a11y testを追加する
3. Composition Rootへ登録する
4. `api/config.json`でmodule IDをenableする
5. Registry／visual／keyboard conformance testを実行する

Core package、Provider adapter、App Shellを編集する手順は含めない。

## 10. Conformance

UI Moduleごとに最低限、次を検査する。

- manifest positive／negative fixture、duplicate ID、unknown version
- required capability不足とcanonical summary値の欠損
- Core hostが作るloading／partial／stale／error状態
- compact／normal、narrow width、長い翻訳、巨大数値
- keyboard focus、accessible name、色以外の増減表現
- secret、Provider固有field、remote requestがclient bundle／runtimeにないこと
- config export／importとversion migration

Core Skeleton v0の合格条件は、example moduleがCore packageを変更せず、Composition Rootとconfigだけで追加／削除できることである。

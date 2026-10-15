# UI extensions

This is the developer-owned entry point for trusted frontend extensions.
External data access belongs in [`api/`](../api/README.md); UI components do
not belong in provider adapters.

## Implemented today

`chart.symbol-summary` modules can be added without editing Core:

1. Add a component and manifest under `extensions/<feature>/`.
2. Register it statically in [`index.ts`](./index.ts).
3. Enable its exact `id@version` in `api/config.json`.

Static registration is intentional. Trader never imports a component path
from JSON or downloads executable UI code at runtime.

## New end-to-end data features

A feature such as an options chain has two separate responsibilities:

```text
api/yahoo/options.server.ts       vendor request and normalization
extensions/options/              detail panel, copy, and styles
api/config.json                   provider/module selection and ordering
```

The current generic host is implemented only for the chart symbol summary.
Adding a brand-new symbol-detail tab still requires a reviewed Core host/route
connection in `src/`. Before shipping the first such feature, extract that one
connection into a generic symbol-detail extension host; subsequent features can
then remain in `api/`, `extensions/`, and `api/config.json`.

Options chains should be loaded only after the user opens the relevant panel;
they should not be included in every symbol workspace response.

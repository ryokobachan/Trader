# Contributing to Unicorn

Thanks for helping improve Unicorn.

## Development

1. Create a focused branch.
2. Install dependencies with `npm install`.
3. Run the mock app with `npm run dev -- --port 3001`.
4. Keep provider-specific payloads behind canonical contracts in `app/platform`.
5. Add or update tests for every behavior change.

Before opening a pull request, run:

```bash
npm run lint
npm test
npx tsc --noEmit
npm audit --omit=dev
```

Do not commit API keys, cookies, provider responses, downloaded market data, or credentials copied from another project. Real-data adapters must remain opt-in and document their access and redistribution constraints.

## Pull requests

Keep changes small enough to review, explain the user or developer impact, and include screenshots for visible UI changes. Breaking contract changes require a version bump and migration notes.

# Contributing

Thanks for your interest. While the project is in preview we are **not accepting feature pull requests yet**: the core is still moving, and we'd rather not waste your time on changes that conflict with it. What helps most right now:

- **Bug reports** with steps to reproduce, what you expected, and what happened (logs with ids pseudonymised are fine).
- **Deployment reports**: what broke or confused you when deploying from the README.
- **Small fixes** (typos, docs, obvious bugs) as pull requests — keep them focused.
- **Security issues**: never in public issues; see [SECURITY.md](SECURITY.md).

For anything larger, open an issue first so we can agree on the approach.

## Development

```bash
npm ci
npx tsc --noEmit -p packages/gateway
npx tsc --noEmit -p packages/infra
npm test --workspace @agentforeach/gateway
```

To run the Functions app locally, see "Run locally" in the [README](README.md).

## Conventions

- **Tests with every fix.** Tests use `node:test`; add a test that fails without your change. New test files must be added to the `test` script in `packages/gateway/package.json`.
- **Cosmos containers are defined in code.** If you change a store's container (partition key, TTL, indexing), run `npm run db:catalog --workspace @agentforeach/gateway` and commit the regenerated `packages/infra/cosmos-containers.json`; CI fails when it is out of date.
- **Behaviour changes** that affect operators go in [docs/UPGRADING.md](docs/UPGRADING.md).
- **No personal data in logs.** Use `redactId()` for user, session and chat ids and `describeText()` instead of message text.
- **Untrusted URLs** go through `safeFetch()` (`utils/safe-fetch.ts`), never `fetch()`.
- Match the style of the surrounding code; comments explain why, not what.

## License

By contributing you agree that your contributions are licensed under the [Apache-2.0](LICENSE) license.

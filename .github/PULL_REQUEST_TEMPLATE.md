## What this changes

<!-- One or two sentences. Link the issue it fixes. -->

## How it was tested

<!-- Tests added or updated; what you ran. -->

## Checklist

- [ ] A test fails without this change and passes with it
- [ ] New test files are listed in the `test` script in `gateway/package.json`
- [ ] Collection changes: `npm run db:catalog --workspace @agentforeach/gateway` was run and `infra/cosmos-containers.json` and `infra/postgres-schema.sql` are committed
- [ ] Operator-visible behaviour changes are in `docs/UPGRADING.md`
- [ ] No personal data in logs (`redactId()`, `describeText()`); untrusted URLs go through `safeFetch()`

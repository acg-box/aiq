# Production browser acceptance

Run this test only after the Official matrix is published. Supply the exact production origin:

```sh
AIQ_PRODUCTION_ORIGIN=https://aiq.wiki npm run test:browser:production
```

The command does not start a local server and does not use secrets. The browser blocks non-read
requests. The test fails unless the public site contains exactly 17 Official configurations, 17
configuration runs, and 1,224 task results. It also checks the public method, trend, radar,
duration, token, and API-equivalent cost evidence.

Use the local published-data mock to validate the acceptance contract without a production read:

```sh
npm run test:browser:production-contract --workspace @aiq/web
```

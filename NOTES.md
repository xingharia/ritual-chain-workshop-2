# Build notes — RitualPredict (Bootcamp 2)

My own work on top of the `cozfuttu/ritual-chain-workshop-2` starter. The chain was
down while I did this, so everything below is **local**: implementing the contract,
compiling, and running a full test suite against a local Hardhat node.

## What the starter ships

The starter is a skeleton: `RitualPredict.sol` has its lifecycle functions stubbed
with `// we'll fill this up` — `createMarket`, `onScheduledResolve`, `_readOracle`,
`_pickExecutor`, and `_scheduleResolution`. The README's "Design decisions" section
is effectively the spec. The default `test/Counter.ts` references a `Counter`
contract that does not exist in this repo, so it was dead on arrival.

## What I implemented

- **`createMarket`** — validates the rule (non-empty strings, `MIN_BETTING_SECONDS`,
  `MIN_RESOLVE_DELAY_SECONDS`, `MAX_MARKET_SECONDS`), converts the human durations to
  **block numbers** via `blockTimeMs`, stores the market, books the self-resolution,
  and emits `MarketCreated` + `ResolutionRuleSet`.
- **`_scheduleResolution`** — one `Scheduler.schedule()` call booking `MAX_ATTEMPTS`
  executions `RETRY_INTERVAL_BLOCKS` apart, callback `onScheduledResolve(0, marketId)`
  with the `uint256(0)` placeholder the Scheduler overwrites with the real
  `executionIndex`. Fee floored at `MIN_MAX_FEE_PER_GAS`, `payer = address(this)`.
- **`_pickExecutor`** — `TEEServiceRegistry.pickServiceByCapability(HTTP_CALL, …)`
  with a per-attempt seed so one unhealthy executor can't sink a market.
- **`_readOracle`** — builds the **13-field HTTP request** for `0x0801`
  (`executor, encryptedSecrets, ttl, secretSignatures, userPublicKey, url, method,
  headerKeys, headerValues, body, dkmsKeyIndex, dkmsKeyFormat, piiEnabled`), decodes
  the async envelope through an external `try` (so an unsettled/malformed response is
  a caught failure, not a revert), then extracts the number with the jq precompile.
- **`onScheduledResolve`** — `OnlyScheduler` guard, idempotent, increments attempts,
  reads the oracle, compares to target, resolves YES/NO, and — a failed read is never
  a NO — invalidates only after `MAX_ATTEMPTS`. Empty winning side → `Invalid`
  (refundable). Cancels the remaining booked attempts on success.

I also removed the dead `Counter.ts` and added `contracts/test/Mocks.sol` +
`test/RitualPredict.ts`.

## Steps I struggled with

1. **Testing without Ritual system contracts.** On a vanilla Hardhat node the
   Scheduler (`0x56e7…`), HTTP (`0x0801`), jq (`0x0803`), TEE registry and RitualWallet
   are empty accounts, so even the **constructor** reverts (it calls
   `Scheduler.approveScheduler`). I solved this by deploying local mocks, copying their
   runtime onto the canonical addresses with `setCode`, and then driving
   `onScheduledResolve` by **impersonating the Scheduler address**.
2. **The async HTTP envelope.** `decodeHttpResponse` unwraps `(bytes simmedInput,
   bytes actualOutput)` and then the 5-field response; during simulation `actualOutput`
   is empty, which must read as a *failure* rather than a revert. Getting the outer
   `try`/`catch` boundary right (so bad bytes surface as a caught failure and don't roll
   back the attempt counter) took a couple of iterations.
3. **Field order of the 13-field HTTP request** — easy to get subtly wrong; I pinned it
   against `ritual-dapp-skills/skills/ritual-dapp-http`.

## Local run

```
npx hardhat compile        # solc 0.8.28, clean
npx hardhat test nodejs    # 13 passing
```

All 13 tests pass: market creation + rule validation, YES/NO pool accounting, betting
window enforcement, the Open→Closed view transition, a full YES resolution with a
proportional pull-based payout, the 3-attempt-failure → Invalid → refund path, the
empty-winning-side → Invalid path, non-200 handled as a failure (never a NO), the
`OnlyScheduler` guard, and RitualWallet funding.

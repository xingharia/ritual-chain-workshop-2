import assert from "node:assert/strict";
import { describe, it, beforeEach } from "node:test";

import { network } from "hardhat";
import { encodeAbiParameters, getAddress, type Address } from "viem";

// Canonical Ritual Chain system addresses (mirrors contracts/ritual/RitualChain.sol).
const SCHEDULER = getAddress("0x56e776BAE2DD60664b69Bd5F865F1180ffB7D58B");
const RITUAL_WALLET = getAddress("0x532F0dF0896F353d8C3DD8cc134e8129DA2a3948");
const TEE_REGISTRY = getAddress("0x9644e8562cE0Fe12b4deeC4163c064A8862Bf47F");
const HTTP = getAddress("0x0000000000000000000000000000000000000801");
const JQ = getAddress("0x0000000000000000000000000000000000000803");

const A_EXECUTOR = getAddress("0x000000000000000000000000000000000000BEEF");

// blockTimeMs = 1000 makes _secondsToBlocks(n) == n blocks, so durations are easy
// to reason about in tests.
const BLOCK_TIME_MS = 1000n;

// Comparator enum: GT=0, GTE=1, LT=2, LTE=3.  MarketState: Open=0, Closed=1,
// Resolving=2, Resolved=3, Invalid=4.  Outcome: Unresolved=0, Yes=1, No=2.

function httpEnvelope(status: number, body: `0x${string}` = "0x") {
  const actualOutput = encodeAbiParameters(
    [
      { type: "uint16" },
      { type: "string[]" },
      { type: "string[]" },
      { type: "bytes" },
      { type: "string" },
    ],
    [status, [], [], body, ""],
  );
  return encodeAbiParameters(
    [{ type: "bytes" }, { type: "bytes" }],
    ["0x", actualOutput],
  );
}

function jqUint(value: bigint) {
  return encodeAbiParameters([{ type: "uint256" }], [value]);
}

const NEW_MARKET = {
  question: "Will ETH/USD be at least $4,000 at resolution?",
  oracleUrl: "https://oracle.example/eth",
  jsonPath: ".price",
  target: 4000n,
  comparator: 1, // GTE
  bettingSeconds: 30n,
  resolveDelaySeconds: 15n,
} as const;

describe("RitualPredict", async () => {
  const { viem, networkHelpers } = await network.create();
  const publicClient = await viem.getPublicClient();
  const [deployer, alice, bob] = await viem.getWalletClients();

  let predict: any;
  let scheduler: any;
  let registry: any;
  let httpMock: any;
  let jqMock: any;

  async function placeCode(name: string, at: Address) {
    const testClient = await viem.getTestClient();
    const tmp = await viem.deployContract(name as any);
    const code = await publicClient.getCode({ address: tmp.address });
    await testClient.setCode({ address: at, bytecode: code! });
    return viem.getContractAt(name as any, at);
  }

  beforeEach(async () => {
    // Inject the Ritual system contracts at their canonical addresses.
    scheduler = await placeCode("MockScheduler", SCHEDULER);
    registry = await placeCode("MockTEERegistry", TEE_REGISTRY);
    await placeCode("MockRitualWallet", RITUAL_WALLET);
    httpMock = await placeCode("MockHttp", HTTP);
    jqMock = await placeCode("MockJq", JQ);

    // Default: a healthy executor is available.
    await registry.write.set([A_EXECUTOR, true]);

    predict = await viem.deployContract("RitualPredict", [BLOCK_TIME_MS]);
  });

  async function createDefault() {
    await predict.write.createMarket([NEW_MARKET]);
    return 1n;
  }

  async function resolveAsScheduler(marketId: bigint) {
    await networkHelpers.impersonateAccount(SCHEDULER);
    await networkHelpers.setBalance(SCHEDULER, 10n ** 20n);
    const wallet = await viem.getWalletClient(SCHEDULER);
    const asScheduler = await viem.getContractAt(
      "RitualPredict",
      predict.address,
      { client: { wallet } },
    );
    await asScheduler.write.onScheduledResolve([0n, marketId]);
  }

  it("creates a market, books resolution, and emits", async () => {
    await viem.assertions.emit(
      predict.write.createMarket([NEW_MARKET]),
      predict,
      "MarketCreated",
    );
    assert.equal(await predict.read.marketCount(), 1n);
    const m = await predict.read.getMarket([1n]);
    assert.equal(m.creator, getAddress(deployer.account.address));
    assert.equal(m.question, NEW_MARKET.question);
    assert.equal(m.state, 0); // Open
    assert.equal(m.target, 4000n);
    assert.notEqual(m.scheduleId, 0n); // scheduler handed out an id
  });

  it("rejects a too-short betting window", async () => {
    await viem.assertions.revertWithCustomError(
      predict.write.createMarket([{ ...NEW_MARKET, bettingSeconds: 5n }]),
      predict,
      "BadDuration",
    );
  });

  it("rejects an empty question", async () => {
    await viem.assertions.revertWithCustomError(
      predict.write.createMarket([{ ...NEW_MARKET, question: "" }]),
      predict,
      "EmptyString",
    );
  });

  it("accepts YES/NO bets and tracks pools", async () => {
    const id = await createDefault();
    await predict.write.bet([id, true], {
      account: alice.account,
      value: 10n ** 18n,
    });
    await predict.write.bet([id, false], {
      account: bob.account,
      value: 3n * 10n ** 18n,
    });

    const m = await predict.read.getMarket([id]);
    assert.equal(m.totalYes, 10n ** 18n);
    assert.equal(m.totalNo, 3n * 10n ** 18n);
    assert.equal(
      await predict.read.yesStake([id, alice.account.address]),
      10n ** 18n,
    );
  });

  it("rejects a zero-value bet", async () => {
    const id = await createDefault();
    await viem.assertions.revertWithCustomError(
      predict.write.bet([id, true], { account: alice.account, value: 0n }),
      predict,
      "ZeroStake",
    );
  });

  it("rejects bets after the window closes", async () => {
    const id = await createDefault();
    await networkHelpers.mine(31); // past closeBlock (30 blocks)
    await viem.assertions.revertWithCustomError(
      predict.write.bet([id, true], { account: alice.account, value: 10n ** 18n }),
      predict,
      "BettingClosed",
    );
  });

  it("view flips Open -> Closed after the window", async () => {
    const id = await createDefault();
    assert.equal((await predict.read.getMarket([id])).state, 0); // Open
    await networkHelpers.mine(31);
    assert.equal((await predict.read.getMarket([id])).state, 1); // Closed
  });

  it("resolves YES and pays winners proportionally", async () => {
    const id = await createDefault();
    await predict.write.bet([id, true], { account: alice.account, value: 10n ** 18n });
    await predict.write.bet([id, false], { account: bob.account, value: 10n ** 18n });

    // Oracle read: HTTP 200 + jq value 4200 (>= target 4000) => YES.
    await httpMock.write.setEnvelope([httpEnvelope(200)]);
    await jqMock.write.setOutput([jqUint(4200n)]);

    await resolveAsScheduler(id);

    const m = await predict.read.getMarket([id]);
    assert.equal(m.state, 3); // Resolved
    assert.equal(m.outcome, 1); // Yes
    assert.equal(m.observedValue, 4200n);

    // Sole winner (alice) takes the whole 2 ETH pool.
    await viem.assertions.emitWithArgs(
      predict.write.claimWinnings([id], { account: alice.account }),
      predict,
      "WinningsClaimed",
      [id, getAddress(alice.account.address), 2n * 10n ** 18n],
    );
    // Loser gets nothing.
    await viem.assertions.revertWithCustomError(
      predict.write.claimWinnings([id], { account: bob.account }),
      predict,
      "NothingToClaim",
    );
  });

  it("invalidates after MAX_ATTEMPTS failed reads, then refunds", async () => {
    const id = await createDefault();
    await predict.write.bet([id, true], { account: alice.account, value: 10n ** 18n });

    // No executor available => every read fails.
    await registry.write.set([A_EXECUTOR, false]);

    await resolveAsScheduler(id);
    assert.equal((await predict.read.getMarket([id])).state, 2); // Resolving
    await resolveAsScheduler(id);
    await resolveAsScheduler(id); // third attempt hits MAX_ATTEMPTS

    assert.equal((await predict.read.getMarket([id])).state, 4); // Invalid

    await viem.assertions.emitWithArgs(
      predict.write.claimRefund([id], { account: alice.account }),
      predict,
      "StakeRefunded",
      [id, getAddress(alice.account.address), 10n ** 18n],
    );
  });

  it("treats an empty winning side as Invalid (refundable)", async () => {
    const id = await createDefault();
    // Only NO is backed, but the oracle resolves YES.
    await predict.write.bet([id, false], { account: bob.account, value: 10n ** 18n });
    await httpMock.write.setEnvelope([httpEnvelope(200)]);
    await jqMock.write.setOutput([jqUint(5000n)]); // >= target => YES, but YES pool empty

    await resolveAsScheduler(id);

    const m = await predict.read.getMarket([id]);
    assert.equal(m.state, 4); // Invalid
    assert.equal(m.outcome, 1); // Yes recorded
    await viem.assertions.emitWithArgs(
      predict.write.claimRefund([id], { account: bob.account }),
      predict,
      "StakeRefunded",
      [id, getAddress(bob.account.address), 10n ** 18n],
    );
  });

  it("a non-200 oracle response is a failure, never a NO", async () => {
    const id = await createDefault();
    await predict.write.bet([id, false], { account: bob.account, value: 10n ** 18n });
    await httpMock.write.setEnvelope([httpEnvelope(503)]); // service unavailable
    await jqMock.write.setOutput([jqUint(1n)]);

    await resolveAsScheduler(id);
    // one failed attempt: still Resolving, not resolved as NO
    assert.equal((await predict.read.getMarket([id])).state, 2);
    assert.equal((await predict.read.getMarket([id])).outcome, 0); // Unresolved
  });

  it("only the Scheduler may drive resolution", async () => {
    const id = await createDefault();
    await viem.assertions.revertWithCustomError(
      predict.write.onScheduledResolve([0n, id], { account: alice.account }),
      predict,
      "OnlyScheduler",
    );
  });

  it("funds execution via the RitualWallet", async () => {
    await predict.write.fundExecution([100n], { value: 5n * 10n ** 17n });
    assert.equal(await predict.read.executionBalance(), 5n * 10n ** 17n);
  });
});

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  OFFICIAL_PRICE_CATALOG,
  aggregateAllPluginCost,
  aggregateRunCost,
  aggregateSessionCost,
  calculateRequestCost,
  costForUsage,
  findModelPrice,
  formatUsd,
  mergePriceCatalogs,
  type PriceCatalog,
  type UsageRequestRecord,
} from "../src/cost/index.js";

const TEST_CATALOG: PriceCatalog = {
  entries: [
    {
      priceId: "dsh:test-small",
      provider: "test-dsh",
      model: "small",
      currency: "USD",
      checkedAt: "2026-09-09T00:00:00.000Z",
      sourceUrl: "test://dsh",
      sourceType: "custom",
      rates: {
        inputUsdPerMillion: "1.00",
        cacheReadUsdPerMillion: "0.10",
        cacheWriteUsdPerMillion: "1.25",
        outputUsdPerMillion: "2.00",
      },
    },
    {
      priceId: "caller:test-large",
      provider: "test-caller",
      model: "large",
      currency: "USD",
      checkedAt: "2026-09-09T00:00:00.000Z",
      sourceUrl: "test://caller",
      sourceType: "custom",
      rates: {
        inputUsdPerMillion: "10.00",
        cacheReadUsdPerMillion: "1.00",
        cacheWriteUsdPerMillion: "12.50",
        outputUsdPerMillion: "20.00",
      },
    },
  ],
};

function request(id: string, overrides: Partial<UsageRequestRecord> = {}): UsageRequestRecord {
  return {
    requestRecordId: id,
    runId: "run-1",
    sessionId: "session-1",
    taskId: "task-1",
    submissionId: "sub-1",
    requestOrigin: "delegated",
    provider: "test-dsh",
    model: "small",
    startedAt: "2026-09-09T12:00:00.000Z",
    status: "completed",
    usageSource: "llm-stream",
    usage: {
      inputTokens: 1_000,
      cacheReadTokens: 2_000,
      cacheWriteTokens: 3_000,
      outputTokens: 100,
      reasoningTokens: 80,
    },
    callerModel: {
      provider: "test-caller",
      id: "large",
      source: "caller-reported",
    },
    ...overrides,
  };
}

test("costForUsage charges mutually exclusive buckets and does not charge reasoning twice", () => {
  const entry = findModelPrice(TEST_CATALOG, "test-dsh", "small", undefined);
  assert.ok(entry);

  const cost = costForUsage(request("req-1"), entry);

  assert.equal(cost.picoUsd, "5150000000");
  assert.equal(formatUsd(cost), "$0.005150");
});

test("calculateRequestCost compares the same request usage against caller model price", () => {
  const result = calculateRequestCost(request("req-1"), TEST_CATALOG);

  assert.equal(result.comparable, true);
  assert.deepEqual(result.missingReasons, []);
  assert.equal(result.dshCost?.picoUsd, "5150000000");
  assert.equal(result.callerEquivalentCost?.picoUsd, "51500000000");
  assert.equal(result.saving?.picoUsd, "46350000000");
});

test("aggregate costs dedupe requestRecordId and keep unknown requests partial", () => {
  const records = [
    request("req-1"),
    request("req-1", { status: "failed" }),
    request("req-2", { sessionId: "session-2" }),
    request("req-3", { usage: undefined, sessionId: "session-2" }),
    request("req-4", { requestOrigin: "manual-dsh", sessionId: "session-3" }),
  ];

  const session = aggregateSessionCost("session-2", records, TEST_CATALOG);
  const run = aggregateRunCost("run-1", records, TEST_CATALOG);
  const all = aggregateAllPluginCost(records, TEST_CATALOG);

  assert.equal(session.requestCount, 2);
  assert.equal(session.comparableRequestCount, 1);
  assert.equal(session.partial, true);
  assert.equal(run.requestCount, 4);
  assert.equal(run.comparableRequestCount, 2);
  assert.equal(run.saving?.picoUsd, "92700000000");
  assert.equal(all.coverage.missingReasons["usage-missing"], 1);
  assert.equal(all.coverage.missingReasons["non-comparable-origin"], 1);
});

test("official catalog applies OpenAI long-context and DeepSeek weekday peak rules per request", () => {
  const astra = findModelPrice(OFFICIAL_PRICE_CATALOG, "openai", "gpt-6-astra", "standard");
  const flash = findModelPrice(OFFICIAL_PRICE_CATALOG, "deepseek-official", "deepseek-v4-flash", undefined);
  assert.ok(astra);
  assert.ok(flash);

  const normalContext = costForUsage(
    request("req-normal", {
      provider: "openai",
      model: "gpt-6-astra",
      serviceTier: "standard",
      usage: { inputTokens: 272_000, outputTokens: 1_000 },
    }),
    astra,
  );
  const longContext = costForUsage(
    request("req-long", {
      provider: "openai",
      model: "gpt-6-astra",
      serviceTier: "standard",
      usage: { inputTokens: 272_001, cacheReadTokens: 1_000, cacheWriteTokens: 1_000, outputTokens: 1_000 },
    }),
    astra,
  );
  const deepseekPeak = costForUsage(
    request("req-peak", {
      provider: "deepseek-official",
      model: "deepseek-v4-flash",
      startedAt: "2026-09-09T02:00:00.000Z",
      usage: { inputTokens: 1_000_000, cacheReadTokens: 1_000_000, outputTokens: 1_000_000 },
    }),
    flash,
  );
  const deepseekOffPeak = costForUsage(
    request("req-off-peak", {
      provider: "deepseek-official",
      model: "deepseek-v4-flash",
      startedAt: "2026-09-09T12:00:00.000Z",
      usage: { inputTokens: 1_000_000, cacheReadTokens: 1_000_000, outputTokens: 1_000_000 },
    }),
    flash,
  );

  assert.equal(normalContext.picoUsd, "2770000000000");
  assert.equal(longContext.picoUsd, "5542020000000");
  assert.equal(deepseekPeak.picoUsd, "1774000000000");
  assert.equal(deepseekOffPeak.picoUsd, "887000000000");
});

test("price lookup uses request valid time and treats checkedAt as observation metadata", () => {
  const catalog: PriceCatalog = {
    entries: [
      {
        priceId: "official:old",
        provider: "vendor",
        model: "model",
        currency: "USD",
        checkedAt: "2026-09-09T00:00:00.000Z",
        sourceUrl: "test://old",
        sourceType: "official",
        validFrom: "2026-01-01T00:00:00.000Z",
        validTo: "2026-10-01T00:00:00.000Z",
        rates: { inputUsdPerMillion: "1.00", outputUsdPerMillion: "1.00" },
      },
      {
        priceId: "official:newer-but-not-yet-valid",
        provider: "vendor",
        model: "model",
        currency: "USD",
        checkedAt: "2026-09-09T00:00:00.000Z",
        sourceUrl: "test://new",
        sourceType: "official",
        validFrom: "2026-10-01T00:00:00.000Z",
        rates: { inputUsdPerMillion: "100.00", outputUsdPerMillion: "100.00" },
      },
    ],
  };

  const September = calculateRequestCost(
    request("req-sep", { provider: "vendor", model: "model", usage: { inputTokens: 1_000_000, outputTokens: 0 } }),
    catalog,
  );
  const October = calculateRequestCost(
    request("req-oct", {
      provider: "vendor",
      model: "model",
      startedAt: "2026-10-02T00:00:00.000Z",
      usage: { inputTokens: 1_000_000, outputTokens: 0 },
    }),
    catalog,
  );

  assert.equal(September.dshPriceId, "official:old");
  assert.equal(September.dshCost?.picoUsd, "1000000000000");
  assert.equal(October.dshPriceId, "official:newer-but-not-yet-valid");
  assert.equal(October.dshCost?.picoUsd, "100000000000000");
});


test("official seed prices start at their checked date and future entries do not reprice old requests", () => {
  const catalog = mergePriceCatalogs(OFFICIAL_PRICE_CATALOG, {
    entries: [
      {
        priceId: "openai:gpt-6-astra:standard:2026-10-01",
        provider: "openai",
        model: "gpt-6-astra",
        serviceTier: "standard",
        currency: "USD",
        checkedAt: "2026-10-01T00:00:00.000Z",
        validFrom: "2026-10-01T00:00:00.000Z",
        sourceUrl: "test://future-official",
        sourceType: "official",
        rates: {
          inputUsdPerMillion: "100.00",
          cacheReadUsdPerMillion: "10.00",
          cacheWriteUsdPerMillion: "125.00",
          outputUsdPerMillion: "200.00",
        },
      },
    ],
  });

  const beforeSeed = calculateRequestCost(
    request("req-before-seed", {
      provider: "openai",
      model: "gpt-6-astra",
      serviceTier: "standard",
      startedAt: "2026-09-08T23:59:59.000Z",
      usage: { inputTokens: 1_000, outputTokens: 0 },
    }),
    catalog,
  );
  const seedPeriod = calculateRequestCost(
    request("req-seed-period", {
      provider: "openai",
      model: "gpt-6-astra",
      serviceTier: "standard",
      startedAt: "2026-09-09T12:00:00.000Z",
      usage: { inputTokens: 1_000, outputTokens: 0 },
    }),
    catalog,
  );
  const futurePeriod = calculateRequestCost(
    request("req-future-period", {
      provider: "openai",
      model: "gpt-6-astra",
      serviceTier: "standard",
      startedAt: "2026-10-02T00:00:00.000Z",
      usage: { inputTokens: 1_000, outputTokens: 0 },
    }),
    catalog,
  );

  assert.equal(beforeSeed.dshPriceId, undefined);
  assert.equal(beforeSeed.missingReasons.includes("dsh-price-missing"), true);
  assert.equal(seedPeriod.dshPriceId, "openai:gpt-6-astra:standard:2026-09-09");
  assert.equal(seedPeriod.dshCost?.picoUsd, "10000000000");
  assert.equal(futurePeriod.dshPriceId, "openai:gpt-6-astra:standard:2026-10-01");
  assert.equal(futurePeriod.dshCost?.picoUsd, "100000000000");
});

test("custom catalog entries override the same provider/model route even with a different priceId", () => {
  const catalog = mergePriceCatalogs(TEST_CATALOG, {
    entries: [
      {
        priceId: "custom:small-override",
        provider: "test-dsh",
        model: "small",
        currency: "USD",
        checkedAt: "2026-09-09T00:00:00.000Z",
        sourceUrl: "file://custom-prices.json",
        sourceType: "custom",
        rates: {
          inputUsdPerMillion: "100.00",
          cacheReadUsdPerMillion: "10.00",
          cacheWriteUsdPerMillion: "125.00",
          outputUsdPerMillion: "200.00",
        },
      },
    ],
  });

  const result = calculateRequestCost(request("req-custom"), catalog);

  assert.equal(result.dshPriceId, "custom:small-override");
  assert.equal(result.dshCost?.picoUsd, "515000000000");
});

test("missing caller or prices are explicit unknowns rather than zero cost", () => {
  const missingCaller = calculateRequestCost(request("req-1", { callerModel: undefined }), TEST_CATALOG);
  const missingDshPrice = calculateRequestCost(request("req-2", { provider: "unknown", model: "missing" }), TEST_CATALOG);

  assert.equal(missingCaller.comparable, false);
  assert.equal(missingCaller.dshCost?.picoUsd, "5150000000");
  assert.equal(missingCaller.callerEquivalentCost, undefined);
  assert.deepEqual(missingCaller.missingReasons, ["caller-model-missing"]);
  assert.equal(missingDshPrice.comparable, false);
  assert.equal(missingDshPrice.missingReasons.includes("dsh-price-missing"), true);
});

test("mergePriceCatalogs allows custom price entries without changing official entries", () => {
  const custom = mergePriceCatalogs(OFFICIAL_PRICE_CATALOG, {
    entries: [
      {
        priceId: "custom:router:model",
        provider: "router",
        model: "model",
        currency: "USD",
        checkedAt: "2026-09-09T00:00:00.000Z",
        sourceUrl: "file://custom",
        sourceType: "custom",
        rates: { inputUsdPerMillion: "0.01", outputUsdPerMillion: "0.02" },
      },
    ],
  });

  assert.ok(findModelPrice(custom, "openai", "gpt-6-astra", "standard"));
  assert.ok(findModelPrice(custom, "router", "model", undefined));
});

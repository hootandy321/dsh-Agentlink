import test from "node:test";
import assert from "node:assert/strict";
import { costForUsage, findModelPrice, OFFICIAL_PRICE_CATALOG, calculateRequestCost, type PriceCatalog, type UsageRequestRecord } from "../src/pricing.js";
import { Config } from "../src/index.js";

function request(overrides: Partial<UsageRequestRecord> = {}): UsageRequestRecord {
  return {
    requestRecordId: "req-1",
    runId: "run-1",
    sessionId: "session-1",
    requestOrigin: "delegated",
    provider: "test-dsh",
    model: "small",
    startedAt: "2026-09-09T12:00:00.000Z",
    status: "completed",
    usage: { inputTokens: 1_000, cacheReadTokens: 2_000, cacheWriteTokens: 3_000, outputTokens: 100, reasoningTokens: 80 },
    callerModel: { provider: "test-caller", id: "large", source: "caller-reported" },
    ...overrides
  };
}

const catalog: PriceCatalog = { entries: [
  { priceId: "dsh:test-small", provider: "test-dsh", model: "small", currency: "USD", checkedAt: "2026-09-09T00:00:00.000Z", sourceUrl: "test://dsh", sourceType: "custom", rates: { inputUsdPerMillion: "1.00", cacheReadUsdPerMillion: "0.10", cacheWriteUsdPerMillion: "1.25", outputUsdPerMillion: "2.00" } },
  { priceId: "caller:test-large", provider: "test-caller", model: "large", currency: "USD", checkedAt: "2026-09-09T00:00:00.000Z", sourceUrl: "test://caller", sourceType: "custom", rates: { inputUsdPerMillion: "10.00", cacheReadUsdPerMillion: "1.00", cacheWriteUsdPerMillion: "12.50", outputUsdPerMillion: "20.00" } }
] };

test("shared cost core charges disjoint buckets and does not double-charge reasoning", () => {
  const entry = findModelPrice(catalog, "test-dsh", "small", undefined);
  assert.ok(entry);
  assert.equal(costForUsage(request(), entry).picoUsd, "5150000000");
});

test("shared cost core reports savings and missing reasons", () => {
  const priced = calculateRequestCost(request(), catalog);
  assert.equal(priced.comparable, true);
  assert.equal(priced.saving?.picoUsd, "46350000000");

  const missing = calculateRequestCost(request({ callerModel: undefined }), catalog);
  assert.equal(missing.comparable, false);
  assert.deepEqual(missing.missingReasons, ["caller-model-missing"]);
});

test("official catalog supports OpenAI long context and DeepSeek peak windows", () => {
  const astra = findModelPrice(OFFICIAL_PRICE_CATALOG, "openai", "gpt-6-astra", "standard");
  const flash = findModelPrice(OFFICIAL_PRICE_CATALOG, "deepseek-official", "deepseek-v4-flash", undefined);
  assert.ok(astra);
  assert.ok(flash);
  assert.equal(costForUsage(request({ provider: "openai", model: "gpt-6-astra", serviceTier: "standard", usage: { inputTokens: 272_001, cacheReadTokens: 1_000, cacheWriteTokens: 1_000, outputTokens: 1_000 } }), astra).picoUsd, "5542020000000");
  assert.equal(costForUsage(request({ provider: "deepseek-official", model: "deepseek-v4-flash", startedAt: "2026-09-09T02:00:00.000Z", usage: { inputTokens: 1_000_000, cacheReadTokens: 1_000_000, outputTokens: 1_000_000 } }), flash).picoUsd, "1774000000000");
});


test("plugin Config preserves advanced custom price fields", () => {
  const parsed = Config({ prices: [{
    priceId: "custom:advanced",
    provider: "custom",
    model: "advanced",
    currency: "USD",
    checkedAt: "2026-09-09T00:00:00.000Z",
    sourceUrl: "custom://advanced",
    sourceType: "custom",
    validFrom: "2026-09-09T00:00:00.000Z",
    validTo: "2026-09-10T00:00:00.000Z",
    rates: { inputUsdPerMillion: "1", outputUsdPerMillion: "2" },
    longContext: { inputTokenThreshold: 100, rates: { inputUsdPerMillion: "3", outputUsdPerMillion: "4" } },
    timeWindows: [{ name: "peak", daysOfWeekUtc: [3], startMinuteUtc: 0, endMinuteUtc: 60, rates: { inputUsdPerMillion: "5", outputUsdPerMillion: "6" } }]
  }] });

  assert.equal(parsed.prices[0]?.validFrom, "2026-09-09T00:00:00.000Z");
  assert.equal(parsed.prices[0]?.longContext?.rates.inputUsdPerMillion, "3");
  assert.equal(parsed.prices[0]?.timeWindows?.[0]?.rates.outputUsdPerMillion, "6");
});


test("basic custom prices do not require optional advanced rules", () => {
  const parsed = Config({prices:[{priceId:"basic",provider:"fixture",model:"small",checkedAt:"2026-09-09T00:00:00.000Z",sourceUrl:"custom://basic",rates:{inputUsdPerMillion:"1",outputUsdPerMillion:"2"}}]});
  assert.equal(parsed.prices[0]?.longContext,undefined);
});

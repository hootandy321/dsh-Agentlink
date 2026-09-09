import type { ModelPriceEntry, PriceCatalog } from "./types.js";

const CHECKED_AT = "2026-09-09T00:00:00.000Z";
const OPENAI_SOURCE = "https://developers.openai.com/api/docs/models";
const DEEPSEEK_SOURCE = "https://api-docs.deepseek.com/quick_start/pricing/";

function openAiStandardPrice(
  model: string,
  inputUsdPerMillion: string,
  cacheReadUsdPerMillion: string,
  outputUsdPerMillion: string,
): ModelPriceEntry {
  const input = Number(inputUsdPerMillion);
  return {
    priceId: `openai:${model}:standard:2026-09-09`,
    provider: "openai",
    model,
    serviceTier: "standard",
    currency: "USD",
    checkedAt: CHECKED_AT,
    validFrom: CHECKED_AT,
    sourceUrl: `${OPENAI_SOURCE}/${model}`,
    sourceType: "official",
    rates: {
      inputUsdPerMillion,
      cacheReadUsdPerMillion,
      cacheWriteUsdPerMillion: (input * 1.25).toFixed(2),
      outputUsdPerMillion,
    },
    longContext: {
      inputTokenThreshold: 272_001,
      rates: {
        inputUsdPerMillion: (input * 2).toFixed(2),
        cacheReadUsdPerMillion: (Number(cacheReadUsdPerMillion) * 2).toFixed(2),
        cacheWriteUsdPerMillion: (input * 2 * 1.25).toFixed(2),
        outputUsdPerMillion: (Number(outputUsdPerMillion) * 1.5).toFixed(2),
      },
    },
  };
}

function deepSeekV4Price(
  provider: "deepseek-official",
  model: "deepseek-v4-flash" | "deepseek-v4-pro" | "deepseek-v4-flash-vision-exp",
  offPeakCacheRead: string,
  offPeakInput: string,
  offPeakOutput: string,
  peakCacheRead: string,
  peakInput: string,
  peakOutput: string,
): ModelPriceEntry {
  return {
    priceId: `${provider}:${model}:official:2026-09-09`,
    provider,
    model,
    currency: "USD",
    checkedAt: CHECKED_AT,
    validFrom: CHECKED_AT,
    sourceUrl: DEEPSEEK_SOURCE,
    sourceType: "official",
    rates: {
      inputUsdPerMillion: offPeakInput,
      cacheReadUsdPerMillion: offPeakCacheRead,
      outputUsdPerMillion: offPeakOutput,
    },
    timeWindows: [
      {
        name: "weekday-peak-01-04-utc",
        daysOfWeekUtc: [1, 2, 3, 4, 5],
        startMinuteUtc: 60,
        endMinuteUtc: 240,
        rates: {
          inputUsdPerMillion: peakInput,
          cacheReadUsdPerMillion: peakCacheRead,
          outputUsdPerMillion: peakOutput,
        },
      },
      {
        name: "weekday-peak-06-10-utc",
        daysOfWeekUtc: [1, 2, 3, 4, 5],
        startMinuteUtc: 360,
        endMinuteUtc: 600,
        rates: {
          inputUsdPerMillion: peakInput,
          cacheReadUsdPerMillion: peakCacheRead,
          outputUsdPerMillion: peakOutput,
        },
      },
    ],
  };
}

export const OFFICIAL_PRICE_CATALOG: PriceCatalog = {
  entries: [
    openAiStandardPrice("gpt-6-astra", "10.00", "1.00", "50.00"),
    openAiStandardPrice("gpt-5.6-sol", "4.00", "0.40", "20.00"),
    deepSeekV4Price("deepseek-official", "deepseek-v4-flash", "0.007", "0.22", "0.66", "0.014", "0.44", "1.32"),
    deepSeekV4Price("deepseek-official", "deepseek-v4-pro", "0.022", "0.66", "1.98", "0.044", "1.32", "3.96"),
    deepSeekV4Price(
      "deepseek-official",
      "deepseek-v4-flash-vision-exp",
      "0.007",
      "0.22",
      "0.66",
      "0.014",
      "0.44",
      "1.32",
    ),
  ],
};

export function mergePriceCatalogs(base: PriceCatalog, custom: PriceCatalog = { entries: [] }): PriceCatalog {
  const byKey = new Map<string, ModelPriceEntry>();
  for (const entry of base.entries) byKey.set(entry.priceId, entry);
  for (const entry of custom.entries) byKey.set(entry.priceId, entry);
  return { entries: [...byKey.values()] };
}

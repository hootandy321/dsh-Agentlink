import type {
  AggregateCost,
  CostCoverage,
  MissingReason,
  ModelPriceEntry,
  MoneyAmount,
  PriceCatalog,
  PriceRates,
  RequestCost,
  UsageRequestRecord,
} from "./types.js";

const PICO_USD_SCALE = 1_000_000_000_000n;
const TOKEN_RATE_SCALE = 1_000_000n;

function assertWholeToken(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${name} must be a non-negative safe integer`);
  }
}

function parseUsdPerMillionToPico(value: string): bigint {
  if (!/^\d+(?:\.\d+)?$/.test(value)) throw new TypeError(`invalid USD rate ${JSON.stringify(value)}`);
  const [whole = "0", fraction = ""] = value.split(".");
  const padded = `${fraction}000000000000`.slice(0, 12);
  return BigInt(whole) * PICO_USD_SCALE + BigInt(padded);
}

function addMoney(left: MoneyAmount | undefined, right: MoneyAmount | undefined): MoneyAmount | undefined {
  if (left === undefined) return right;
  if (right === undefined) return left;
  if (left.currency !== right.currency) return undefined;
  return { currency: left.currency, picoUsd: (BigInt(left.picoUsd) + BigInt(right.picoUsd)).toString() };
}

function subtractMoney(left: MoneyAmount, right: MoneyAmount): MoneyAmount | undefined {
  if (left.currency !== right.currency) return undefined;
  return { currency: left.currency, picoUsd: (BigInt(left.picoUsd) - BigInt(right.picoUsd)).toString() };
}

function totalInputTokens(record: UsageRequestRecord): number {
  const usage = record.usage;
  if (usage === undefined) return 0;
  return usage.inputTokens + (usage.cacheReadTokens ?? 0) + (usage.cacheWriteTokens ?? 0);
}

function minuteOfDayUtc(date: Date): number {
  return date.getUTCHours() * 60 + date.getUTCMinutes();
}

function matchesTimeWindow(entry: ModelPriceEntry, startedAt: string): PriceRates | undefined {
  const date = new Date(startedAt);
  if (Number.isNaN(date.getTime())) throw new TypeError(`invalid request startedAt ${JSON.stringify(startedAt)}`);
  const day = date.getUTCDay();
  const minute = minuteOfDayUtc(date);
  for (const window of entry.timeWindows ?? []) {
    if (window.daysOfWeekUtc !== undefined && !window.daysOfWeekUtc.includes(day)) continue;
    const inWindow =
      window.startMinuteUtc <= window.endMinuteUtc
        ? minute >= window.startMinuteUtc && minute < window.endMinuteUtc
        : minute >= window.startMinuteUtc || minute < window.endMinuteUtc;
    if (inWindow) return window.rates;
  }
  return undefined;
}

function ratesFor(entry: ModelPriceEntry, record: UsageRequestRecord): PriceRates {
  const timeWindowRates = matchesTimeWindow(entry, record.startedAt);
  if (timeWindowRates !== undefined) return timeWindowRates;
  if (entry.longContext !== undefined && totalInputTokens(record) >= entry.longContext.inputTokenThreshold) {
    return entry.longContext.rates;
  }
  return entry.rates;
}

function priceLookupKey(provider: string, model: string, serviceTier: string | undefined, currency: string): string {
  return `${provider}\u0000${model}\u0000${serviceTier ?? ""}\u0000${currency}`;
}

function timestamp(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) throw new TypeError(`invalid price timestamp ${JSON.stringify(value)}`);
  return parsed;
}

function isValidAt(entry: ModelPriceEntry, at: string | undefined): boolean {
  if (at === undefined) return true;
  const atMs = timestamp(at, 0);
  return atMs >= timestamp(entry.validFrom, Number.NEGATIVE_INFINITY) && atMs < timestamp(entry.validTo, Number.POSITIVE_INFINITY);
}

function priceRank(entry: ModelPriceEntry): [number, number, number] {
  return [
    entry.sourceType === "custom" ? 1 : 0,
    timestamp(entry.validFrom, Number.NEGATIVE_INFINITY),
    timestamp(entry.checkedAt, Number.NEGATIVE_INFINITY),
  ];
}

export function findModelPrice(
  catalog: PriceCatalog,
  provider: string,
  model: string,
  serviceTier: string | undefined,
  currency = "USD",
  at?: string,
): ModelPriceEntry | undefined {
  const wanted = priceLookupKey(provider, model, serviceTier, currency);
  const candidates = catalog.entries
    .map((entry, index) => ({ entry, index }))
    .filter(
      ({ entry }) => priceLookupKey(entry.provider, entry.model, entry.serviceTier, entry.currency) === wanted && isValidAt(entry, at),
    );
  candidates.sort((left, right) => {
    const leftRank = priceRank(left.entry);
    const rightRank = priceRank(right.entry);
    for (let index = 0; index < leftRank.length; index += 1) {
      if (rightRank[index]! > leftRank[index]!) return 1;
      if (rightRank[index]! < leftRank[index]!) return -1;
    }
    return right.index - left.index;
  });
  return candidates[0]?.entry;
}

export function costForUsage(record: UsageRequestRecord, entry: ModelPriceEntry): MoneyAmount {
  if (record.usage === undefined) throw new TypeError("usage is required to calculate cost");
  const usage = record.usage;
  assertWholeToken(usage.inputTokens, "inputTokens");
  assertWholeToken(usage.outputTokens, "outputTokens");
  assertWholeToken(usage.cacheReadTokens ?? 0, "cacheReadTokens");
  assertWholeToken(usage.cacheWriteTokens ?? 0, "cacheWriteTokens");
  assertWholeToken(usage.reasoningTokens ?? 0, "reasoningTokens");

  const rates = ratesFor(entry, record);
  const inputRate = parseUsdPerMillionToPico(rates.inputUsdPerMillion);
  const outputRate = parseUsdPerMillionToPico(rates.outputUsdPerMillion);
  const cacheReadRate = rates.cacheReadUsdPerMillion === undefined ? undefined : parseUsdPerMillionToPico(rates.cacheReadUsdPerMillion);
  const cacheWriteRate = rates.cacheWriteUsdPerMillion === undefined ? undefined : parseUsdPerMillionToPico(rates.cacheWriteUsdPerMillion);

  if ((usage.cacheReadTokens ?? 0) > 0 && cacheReadRate === undefined) {
    throw new TypeError(`price ${entry.priceId} does not support cacheReadTokens`);
  }
  if ((usage.cacheWriteTokens ?? 0) > 0 && cacheWriteRate === undefined) {
    throw new TypeError(`price ${entry.priceId} does not support cacheWriteTokens`);
  }

  let pico = 0n;
  pico += (BigInt(usage.inputTokens) * inputRate) / TOKEN_RATE_SCALE;
  pico += (BigInt(usage.outputTokens) * outputRate) / TOKEN_RATE_SCALE;
  pico += (BigInt(usage.cacheReadTokens ?? 0) * (cacheReadRate ?? 0n)) / TOKEN_RATE_SCALE;
  pico += (BigInt(usage.cacheWriteTokens ?? 0) * (cacheWriteRate ?? 0n)) / TOKEN_RATE_SCALE;
  return { currency: entry.currency, picoUsd: pico.toString() };
}

export function calculateRequestCost(record: UsageRequestRecord, catalog: PriceCatalog, currency = "USD"): RequestCost {
  const missingReasons: MissingReason[] = [];
  let dshCost: MoneyAmount | undefined;
  let callerEquivalentCost: MoneyAmount | undefined;
  let dshPriceId: string | undefined;
  let callerPriceId: string | undefined;

  if (record.usage === undefined) {
    missingReasons.push("usage-missing");
  }

  const dshPrice = findModelPrice(catalog, record.provider, record.model, record.serviceTier, currency, record.startedAt);
  if (dshPrice === undefined) {
    missingReasons.push("dsh-price-missing");
  } else if (record.usage !== undefined) {
    try {
      dshCost = costForUsage(record, dshPrice);
      dshPriceId = dshPrice.priceId;
    } catch {
      missingReasons.push("dsh-price-missing");
    }
  }

  if (record.requestOrigin !== "delegated" && record.requestOrigin !== "dsh-internal") {
    missingReasons.push("non-comparable-origin");
  }

  if (record.callerModel === undefined || record.callerModel.source === "unknown") {
    missingReasons.push("caller-model-missing");
  } else {
    const callerPrice = findModelPrice(
      catalog,
      record.callerModel.provider,
      record.callerModel.id,
      record.callerModel.serviceTier,
      currency,
      record.startedAt,
    );
    if (callerPrice === undefined) {
      missingReasons.push("caller-price-missing");
    } else if (record.usage !== undefined) {
      try {
        callerEquivalentCost = costForUsage(
          {
            ...record,
            provider: record.callerModel.provider,
            model: record.callerModel.id,
            ...(record.callerModel.serviceTier === undefined ? {} : { serviceTier: record.callerModel.serviceTier }),
          },
          callerPrice,
        );
        callerPriceId = callerPrice.priceId;
      } catch {
        missingReasons.push("unsupported-comparison-bucket");
      }
    }
  }

  const saving =
    dshCost !== undefined && callerEquivalentCost !== undefined ? subtractMoney(callerEquivalentCost, dshCost) : undefined;
  if (dshCost !== undefined && callerEquivalentCost !== undefined && saving === undefined) missingReasons.push("currency-mismatch");

  const comparable = missingReasons.length === 0 && dshCost !== undefined && callerEquivalentCost !== undefined && saving !== undefined;
  return {
    requestRecordId: record.requestRecordId,
    runId: record.runId,
    sessionId: record.sessionId,
    ...(record.taskId === undefined ? {} : { taskId: record.taskId }),
    comparable,
    missingReasons,
    ...(dshCost === undefined ? {} : { dshCost }),
    ...(callerEquivalentCost === undefined ? {} : { callerEquivalentCost }),
    ...(saving === undefined ? {} : { saving }),
    ...(dshPriceId === undefined ? {} : { dshPriceId }),
    ...(callerPriceId === undefined ? {} : { callerPriceId }),
  };
}

export function calculateRequestCosts(records: UsageRequestRecord[], catalog: PriceCatalog, currency = "USD"): RequestCost[] {
  const byId = new Map<string, UsageRequestRecord>();
  for (const record of records) byId.set(record.requestRecordId, record);
  return [...byId.values()].map((record) => calculateRequestCost(record, catalog, currency));
}

function makeCoverage(records: UsageRequestRecord[], requestCosts: RequestCost[]): CostCoverage {
  const missingReasons: Partial<Record<MissingReason, number>> = {};
  for (const cost of requestCosts) {
    for (const reason of cost.missingReasons) missingReasons[reason] = (missingReasons[reason] ?? 0) + 1;
  }
  return {
    observedRequests: records.length,
    requestsWithUsage: records.filter((record) => record.usage !== undefined).length,
    dshPricedRequests: requestCosts.filter((cost) => cost.dshCost !== undefined).length,
    comparableRequests: requestCosts.filter((cost) => cost.comparable).length,
    unknownRequests: requestCosts.filter((cost) => !cost.comparable).length,
    missingReasons,
  };
}

export function aggregateCosts(
  scope: AggregateCost["scope"],
  records: UsageRequestRecord[],
  catalog: PriceCatalog,
  options: { scopeId?: string; currency?: string } = {},
): AggregateCost {
  const byId = new Map<string, UsageRequestRecord>();
  for (const record of records) byId.set(record.requestRecordId, record);
  const dedupedRecords = [...byId.values()];
  const requests = dedupedRecords.map((record) => calculateRequestCost(record, catalog, options.currency ?? "USD"));

  const dshCostAllPriced = requests.reduce<MoneyAmount | undefined>((sum, request) => addMoney(sum, request.dshCost), undefined);
  const comparableRequests = requests.filter((request) => request.comparable);
  const dshCostComparable = comparableRequests.reduce<MoneyAmount | undefined>((sum, request) => addMoney(sum, request.dshCost), undefined);
  const callerEquivalentCost = comparableRequests.reduce<MoneyAmount | undefined>(
    (sum, request) => addMoney(sum, request.callerEquivalentCost),
    undefined,
  );
  const saving =
    dshCostComparable !== undefined && callerEquivalentCost !== undefined
      ? subtractMoney(callerEquivalentCost, dshCostComparable)
      : undefined;

  return {
    scope,
    ...(options.scopeId === undefined ? {} : { scopeId: options.scopeId }),
    requestCount: dedupedRecords.length,
    comparableRequestCount: comparableRequests.length,
    ...(dshCostAllPriced?.currency === undefined ? {} : { currency: dshCostAllPriced.currency }),
    ...(dshCostAllPriced === undefined ? {} : { dshCostAllPriced }),
    ...(dshCostComparable === undefined ? {} : { dshCostComparable }),
    ...(callerEquivalentCost === undefined ? {} : { callerEquivalentCost }),
    ...(saving === undefined ? {} : { saving }),
    partial: comparableRequests.length !== dedupedRecords.length,
    coverage: makeCoverage(dedupedRecords, requests),
    requests,
  };
}

export function aggregateSessionCost(sessionId: string, records: UsageRequestRecord[], catalog: PriceCatalog): AggregateCost {
  return aggregateCosts(
    "session",
    records.filter((record) => record.sessionId === sessionId),
    catalog,
    { scopeId: sessionId },
  );
}

export function aggregateRunCost(runId: string, records: UsageRequestRecord[], catalog: PriceCatalog): AggregateCost {
  return aggregateCosts(
    "run",
    records.filter((record) => record.runId === runId),
    catalog,
    { scopeId: runId },
  );
}

export function aggregateAllPluginCost(records: UsageRequestRecord[], catalog: PriceCatalog): AggregateCost {
  return aggregateCosts("all", records, catalog);
}

export function formatUsd(amount: MoneyAmount, precision = 6): string {
  if (amount.currency !== "USD") return `${amount.picoUsd} pico ${amount.currency}`;
  const pico = BigInt(amount.picoUsd);
  const sign = pico < 0n ? "-" : "";
  const abs = pico < 0n ? -pico : pico;
  const whole = abs / PICO_USD_SCALE;
  const fraction = (abs % PICO_USD_SCALE).toString().padStart(12, "0").slice(0, precision);
  return precision === 0 ? `${sign}$${whole.toString()}` : `${sign}$${whole.toString()}.${fraction}`;
}

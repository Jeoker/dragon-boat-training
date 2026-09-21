import type { SeasonSnapshot } from "./c1-contract";
import { ContractValidationError } from "./c1-contract";

function zonedParts(at: Date, timezone: string): number[] {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23"
  }).formatToParts(at);
  const read = (type: Intl.DateTimeFormatPartTypes) => Number(parts.find((part) => part.type === type)?.value);
  return [read("year"), read("month"), read("day"), read("hour"), read("minute"), read("second")];
}

export function assertTimezone(timezone: string): void {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone }).format(new Date(0));
  } catch {
    throw new ContractValidationError("timezone must be a supported IANA time zone.", "timezone");
  }
}

export function seasonEndsAt(endDate: string, timezone: string): string {
  assertTimezone(timezone);
  const [year, month, day] = endDate.split("-").map(Number);
  const next = new Date(Date.UTC(year, month - 1, day + 1));
  const target = [next.getUTCFullYear(), next.getUTCMonth() + 1, next.getUTCDate(), 0, 0, 0];
  const desiredUtc = Date.UTC(target[0], target[1] - 1, target[2]);
  let guess = desiredUtc;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const observed = zonedParts(new Date(guess), timezone);
    const observedAsUtc = Date.UTC(observed[0], observed[1] - 1, observed[2], observed[3], observed[4], observed[5]);
    guess += desiredUtc - observedAsUtc;
    if (zonedParts(new Date(guess), timezone).every((value, index) => value === target[index])) {
      return new Date(guess).toISOString();
    }
  }
  throw new ContractValidationError("The season end boundary cannot be represented in this time zone.", "end_date");
}

export function validateSeasonSnapshot(season: SeasonSnapshot): void {
  if (season.start_date > season.end_date) {
    throw new ContractValidationError("A season cannot end before it starts.", "end_date");
  }
  const expected = seasonEndsAt(season.end_date, season.timezone);
  if (season.season_ends_at !== expected) {
    throw new ContractValidationError("season_ends_at does not match the end date and time zone.", "season_ends_at");
  }
}

export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>).sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

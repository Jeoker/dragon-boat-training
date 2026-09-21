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

export function addCalendarDays(date: string, days: number): string {
  const [year, month, day] = date.split("-").map(Number);
  const result = new Date(Date.UTC(year, month - 1, day + days));
  return result.toISOString().slice(0, 10);
}

export function isMonday(date: string): boolean {
  const [year, month, day] = date.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day)).getUTCDay() === 1;
}

export function dateInTimezone(instant: string, timezone: string): string {
  assertTimezone(timezone);
  const parts = zonedParts(new Date(instant), timezone);
  return [parts[0], parts[1], parts[2]].map((value, index) => String(value).padStart(index === 0 ? 4 : 2, "0")).join("-");
}

export function localDateTimeToIso(date: string, time: string, timezone: string): string {
  assertTimezone(timezone);
  const [year, month, day] = date.split("-").map(Number);
  const [hour, minute] = time.split(":").map(Number);
  const target = [year, month, day, hour, minute, 0];
  const desiredUtc = Date.UTC(year, month - 1, day, hour, minute);
  let guess = desiredUtc;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const observed = zonedParts(new Date(guess), timezone);
    const observedAsUtc = Date.UTC(observed[0], observed[1] - 1, observed[2], observed[3], observed[4], observed[5]);
    guess += desiredUtc - observedAsUtc;
  }
  const matches = (candidate: number) => zonedParts(new Date(candidate), timezone)
    .every((value, index) => value === target[index]);
  if (!matches(guess)) {
    throw new ContractValidationError("The local date and time does not exist in this time zone.", "time");
  }
  for (let offset = -180; offset <= 180; offset += 15) {
    if (offset !== 0 && matches(guess + offset * 60_000)) {
      throw new ContractValidationError("The local date and time is ambiguous in this time zone.", "time");
    }
  }
  return new Date(guess).toISOString();
}

export function seasonEndsAt(endDate: string, timezone: string): string {
  return localDateTimeToIso(addCalendarDays(endDate, 1), "00:00", timezone);
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

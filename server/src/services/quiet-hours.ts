/**
 * Quiet-hours evaluation.
 *
 * A company can define recurring wall-clock windows (in a chosen IANA timezone)
 * during which agents are not autonomously executed. These helpers answer two
 * questions for the scheduler:
 *
 *   - `isQuietHoursActive(config, now)` — is `now` inside an active window?
 *   - `nextQuietHoursEnd(config, now)` — when does the current window close?
 *
 * Timezone handling mirrors the routines cron evaluator: we never do manual
 * offset math, we ask `Intl.DateTimeFormat` for the zoned wall-clock parts of a
 * UTC instant. A window whose `end` is numerically <= `start` crosses midnight
 * (e.g. "22:00" → "08:00"); `days` is interpreted as the weekday the window
 * *starts* on, with the post-midnight remainder spilling into the next day.
 */
import type { QuietHoursConfig } from "@paperclipai/shared";

const WEEKDAY_INDEX: Record<string, number> = {
  Sun: 0,
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
};

interface ZonedParts {
  weekday: number;
  minutesOfDay: number;
}

function getZonedParts(date: Date, timeZone: string): ZonedParts {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour12: false,
    hour: "2-digit",
    minute: "2-digit",
    weekday: "short",
  });
  const parts = formatter.formatToParts(date);
  const map = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  const weekday = WEEKDAY_INDEX[map.weekday ?? ""];
  if (weekday == null) {
    throw new Error(`Unable to resolve weekday for timezone ${timeZone}`);
  }
  // Intl renders midnight as "24" in some environments; normalize to 0.
  const hour = Number(map.hour) % 24;
  const minute = Number(map.minute);
  return { weekday, minutesOfDay: hour * 60 + minute };
}

function parseTimeToMinutes(value: string): number | null {
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(value);
  if (!match) return null;
  return Number(match[1]) * 60 + Number(match[2]);
}

function dayMatches(days: number[], weekday: number): boolean {
  return days.length === 0 || days.includes(weekday);
}

function previousWeekday(weekday: number): number {
  return (weekday + 6) % 7;
}

function floorToMinute(date: Date): Date {
  const copy = new Date(date.getTime());
  copy.setUTCSeconds(0, 0);
  return copy;
}

/**
 * True when `now` falls inside any enabled quiet-hours window.
 * A `null`/disabled config is never active.
 */
export function isQuietHoursActive(config: QuietHoursConfig | null | undefined, now: Date): boolean {
  if (!config || !config.enabled || config.windows.length === 0) return false;

  let parts: ZonedParts;
  try {
    parts = getZonedParts(now, config.timezone);
  } catch {
    // An invalid timezone should never silence agents; treat as inactive.
    return false;
  }
  const { weekday, minutesOfDay } = parts;

  for (const window of config.windows) {
    const start = parseTimeToMinutes(window.start);
    const end = parseTimeToMinutes(window.end);
    if (start == null || end == null || start === end) continue;

    if (start < end) {
      // Same-day window: [start, end) on a matching weekday.
      if (dayMatches(window.days, weekday) && minutesOfDay >= start && minutesOfDay < end) {
        return true;
      }
    } else {
      // Crosses midnight. Evening portion on the start day…
      if (dayMatches(window.days, weekday) && minutesOfDay >= start) return true;
      // …morning portion belongs to the day after the start day.
      if (dayMatches(window.days, previousWeekday(weekday)) && minutesOfDay < end) return true;
    }
  }
  return false;
}

/**
 * The instant (minute-aligned) at which the window currently covering `now`
 * closes — i.e. the first minute from `now` onward that is no longer quiet.
 * Returns `null` when `now` is not currently within a window. Handles
 * overlapping/back-to-back windows by advancing until quiet hours actually end.
 */
export function nextQuietHoursEnd(config: QuietHoursConfig | null | undefined, now: Date): Date | null {
  if (!isQuietHoursActive(config, now)) return null;
  const cursor = floorToMinute(now);
  // Bound the scan: even a 7-day window plus its spill resolves well within 8 days.
  const limitMinutes = 8 * 24 * 60;
  for (let i = 0; i < limitMinutes; i += 1) {
    cursor.setUTCMinutes(cursor.getUTCMinutes() + 1);
    if (!isQuietHoursActive(config, cursor)) {
      return new Date(cursor.getTime());
    }
  }
  return null;
}

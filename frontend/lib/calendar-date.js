// A YYYY-MM-DD calendar date is not an instant in the season's timezone.
// UTC formatting preserves its day, including seasons east of UTC+12.
export function formatCalendarDate(value) {
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone: "UTC", year: "numeric", month: "long", day: "numeric"
  }).format(new Date(`${value}T12:00:00Z`));
}

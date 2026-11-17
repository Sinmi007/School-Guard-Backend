import { ValidateBy, ValidationOptions } from 'class-validator';

/** Parses "YYYY-MM-DD" into a UTC Date, or null if it isn't a real date. */
export function parseDateOnly(value: unknown): Date | null {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return null;
  }
  const d = new Date(`${value}T00:00:00Z`);
  // Rejects 2030-02-30 etc. (Date would silently roll it over)
  return d.toISOString().slice(0, 10) === value ? d : null;
}

/**
 * A real calendar date (YYYY-MM-DD). `past` requires it to be today or
 * earlier (birth dates); otherwise any date from 2000 to 2100 is allowed
 * (licence expiry — an already-expired licence is recorded and flagged, not
 * rejected, so schools can capture drivers who are mid-renewal).
 */
export function IsDateOnly(
  opts: { past?: boolean } = {},
  options?: ValidationOptions,
) {
  return ValidateBy(
    {
      name: 'isDateOnly',
      validator: {
        validate: (value: unknown) => {
          const d = parseDateOnly(value);
          if (!d) return false;
          if (opts.past) {
            return d >= new Date('1940-01-01T00:00:00Z') && d <= new Date();
          }
          return (
            d >= new Date('2000-01-01T00:00:00Z') &&
            d <= new Date('2100-12-31T00:00:00Z')
          );
        },
        defaultMessage: (args) =>
          opts.past
            ? `${args?.property} must be a real date (YYYY-MM-DD) and not in the future`
            : `${args?.property} must be a real date (YYYY-MM-DD)`,
      },
    },
    options,
  );
}

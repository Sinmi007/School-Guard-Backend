/** Shared normalisers/patterns for transport DTOs. */
export const trim = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() : value;

/** Upper-case, single spaces → none (plates, fleet codes). */
export const compactUpper = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.replace(/\s+/g, '').toUpperCase() : value;

/** 24h "HH:MM". */
export const TIME_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/;

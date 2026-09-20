import { z } from 'zod'

/**
 * @fileoverview
 *
 * The one validator for a release's planned production date — the Jira fix version's `releaseDate`
 * (`yyyy-mm-dd`). Called from the `--release` spec parser, the wizard prompt, and the tool schemas,
 * so every surface refuses the same inputs with the same message.
 *
 * No past-date guard on purpose: a PM legitimately back-fills a date, and the confirm summary shows
 * it, which is the human's chance to notice.
 */

export const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/

/**
 * Shape AND calendar validity (`2026-02-30` and `2026-13-01` are refused).
 *
 * Built with `Date.UTC` and read back with the UTC getters, so the round-trip is independent of the
 * process timezone. The local getters would not be: a date-only ISO string parses as UTC midnight
 * (https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Date/parse#date-only_forms),
 * which the local getters in a zone west of UTC report as the previous day.
 *
 * Coverage, honestly: the 4-digit pattern plus the round-trip excludes `0026-01-01` and the
 * expanded-year form `+002026-…`; this is not full ISO 8601 and is not meant to be.
 */
export const isIsoDate = (raw: string): boolean => {
  if (!ISO_DATE_PATTERN.test(raw)) return false

  const [year, month, day] = raw.split('-').map(Number) as [number, number, number]
  const date = new Date(Date.UTC(year, month - 1, day))

  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
}

const describeInvalid = (raw: string): string => {
  return `Release date "${raw}" is not a calendar date in yyyy-mm-dd form.`
}

/** Thrown by {@link assertIsoDate} when a release date is not a calendar date in `yyyy-mm-dd` form. */
export class InvalidReleaseDateError extends Error {
  constructor(raw: string) {
    super(describeInvalid(raw))
    this.name = 'InvalidReleaseDateError'
  }
}

/**
 * Trim, validate, and return the canonical `yyyy-mm-dd` string.
 *
 * @example
 * assertIsoDate(' 2026-10-28 ') // => '2026-10-28'
 * assertIsoDate('2026-02-30')   // throws InvalidReleaseDateError
 */
export const assertIsoDate = (raw: string): string => {
  const trimmed = raw.trim()

  if (!isIsoDate(trimmed)) throw new InvalidReleaseDateError(trimmed)

  return trimmed
}

/**
 * Inquirer's `validate` shape (`true` | message): blank is accepted because every prompt that uses
 * this treats an empty answer as "skip" or "keep current", never as a date.
 */
export const validateOptionalIsoDate = (raw: string): true | string => {
  const trimmed = raw.trim()

  return trimmed === '' || isIsoDate(trimmed) ? true : describeInvalid(trimmed)
}

/**
 * The tool-schema form of the same rule. The agent form (`lib/release-form`) deliberately does NOT
 * use it: form fields carry no measured wire shape, and the re-run's `parseReleaseSpec` is where an
 * invalid date is refused.
 */
export const isoDateSchema = z.string().refine(isIsoDate, {
  message: 'Expected a calendar date in yyyy-mm-dd form.',
})

/** `isoDateSchema` that also admits `""` — the clear intent an editing tool accepts. */
export const isoDateOrClearSchema = z.string().refine(
  (value) => {
    return value === '' || isIsoDate(value)
  },
  { message: 'Expected a calendar date in yyyy-mm-dd form, or "" to clear.' },
)

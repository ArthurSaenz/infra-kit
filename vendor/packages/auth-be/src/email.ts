import type { MagicLinkEmail } from './ports.js'

export interface MagicLinkEmailText {
  subject: string
  intro: string
  linkLabel: string
  expiryPrefix?: string
  warning?: string
}

export const buildMagicLinkUrl = (
  baseUrl: string,
  rawToken: string,
  redirectUrl?: string,
  verifyPath = '/auth/verify',
): string => {
  const base = `${baseUrl}${verifyPath}?token=${rawToken}`

  return redirectUrl ? `${base}&redirect=${encodeURIComponent(redirectUrl)}` : base
}

/** Largest whole unit, so a 72 h invite reads "3 days" rather than "4320 minutes". */
export const formatExpiry = (expMin: number): string => {
  const plural = (n: number, unit: string): string => {
    return `${n} ${unit}${n === 1 ? '' : 's'}`
  }

  if (expMin % (24 * 60) === 0) return plural(expMin / (24 * 60), 'day')

  if (expMin % 60 === 0) return plural(expMin / 60, 'hour')

  return plural(expMin, 'minute')
}

export const renderMagicLinkEmail = (
  to: string,
  link: string,
  expMin: number,
  text: MagicLinkEmailText,
): MagicLinkEmail => {
  const expiryLine = `${text.expiryPrefix ?? 'This link expires in'} ${formatExpiry(expMin)}.`
  const warning = text.warning ?? "If you didn't request this, ignore this email."

  return {
    to,
    subject: text.subject,
    text: `${text.intro}\n\n${link}\n\n${expiryLine}\n\n${warning}`,
    html:
      `<p>${text.intro}</p>` +
      `<p><a href="${link}">${text.linkLabel}</a></p>` +
      `<p>${expiryLine}</p>` +
      `<p>${warning}</p>`,
  }
}

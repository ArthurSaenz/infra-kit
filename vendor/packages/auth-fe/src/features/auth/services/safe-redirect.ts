// eslint-disable-next-line no-control-regex -- matching control characters is the point
const UNSAFE_REDIRECT_CHARS = /[\\\u0000-\u001F\u007F]/

/**
 * Defense-in-depth: the API already returns a server-sanitized redirect, but only ever follow an
 * in-app relative path so a regression upstream can never turn this into an open redirect.
 * Backslashes and control characters are refused like a server-side sanitizer should: browsers read
 * `/\evil.com` as the protocol-relative `//evil.com`.
 *
 * @example
 *     safeRedirect('/chat/1') // '/chat/1'
 *     safeRedirect('//evil.com') // '/'
 */
export const safeRedirect = (value?: string): string => {
  const isInAppPath = !!value && value.startsWith('/') && !value.startsWith('//') && !UNSAFE_REDIRECT_CHARS.test(value)

  return isInAppPath ? value : '/'
}

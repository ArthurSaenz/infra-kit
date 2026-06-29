/**
 * Opens a URL in a new tab without passing referrer or opener information.
 *
 * @param url - The URL to open.
 *
 * @example
 *     openUrlAnonymous('https://example.com')
 *
 */
export const openUrlAnonymous = (url: string) => {
  const newWindow = window.open(url, '_blank', 'noopener,noreferrer')

  if (newWindow) newWindow.opener = null
}

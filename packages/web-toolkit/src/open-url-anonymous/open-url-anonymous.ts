/**
 * @description Open a new window anonymously.
 * @param url - The URL to open.
 */
export const openUrlAnonymous = (url: string) => {
  const newWindow = window.open(url, '_blank', 'noopener,noreferrer')

  if (newWindow) newWindow.opener = null
}

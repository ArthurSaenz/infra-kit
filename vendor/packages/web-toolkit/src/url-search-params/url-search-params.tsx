export const getPathWithSearchParams = (path: string, params?: Record<string, unknown> | null): string => {
  if (params) {
    const searchParams = stringifySearchParams(params)

    return `${path}?${searchParams}`
  }

  return path
}

/**
 * Converts a URLSearchParams instance into a plain object, splitting comma-separated values into arrays.
 *
 * @example
 *     const result = parseSearchParams(new URLSearchParams('foo=a,b&bar=c'))
 *
 */
export const parseSearchParams = (urlSearchParams: URLSearchParams): Record<string, string[] | string> => {
  const entries = urlSearchParams.entries()
  const result: Record<string, string[] | string> = {}

  for (const [key, value] of entries) {
    if (value) {
      if (value.includes(',')) {
        result[key] = value.split(',')
      } else {
        result[key] = value
      }
    }
  }

  return result
}

export const stringifySearchParams = (params: Record<string, unknown>) => {
  const searchParams = new URLSearchParams()

  for (const [key, value] of Object.entries(params)) {
    searchParams.append(key, value as string)
  }

  const searchParamsString = searchParams.toString()

  // Replace the encoded commas with commas.
  const decodedSearchParamsString = searchParamsString.replace(/%2C/g, ',')

  return decodedSearchParamsString
}

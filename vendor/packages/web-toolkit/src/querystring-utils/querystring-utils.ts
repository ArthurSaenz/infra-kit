import qs from 'qs'

/**
 * Stringifies the search object using bracket notation for arrays.
 * For example, we use `qs` to render arrays in bracket notation:
 * output: ?key[0]=value1&key[1]=value2
 *
 * @param searchObject - The search object to stringify.
 * @returns The stringified search object.
 *
 * @example
 *     customStringified({ key: ['value1', 'value2'] })
 *
 */
export const customStringified = (searchObject: Record<string, any> | undefined | null) => {
  return Object.keys(searchObject || {}).length > 0 ? `?${qs.stringify(searchObject, { arrayFormat: 'indices' })}` : ''
}

/**
 * Parses the search string: ?key[0]=value1&key[1]=value2
 *
 * @param searchString - The search string to parse.
 * @returns The parsed search object: { key: ['value1', 'value2'] }
 *
 * @example
 *     customParser('?key[0]=value1&key[1]=value2')
 *
 */
export const customParser = (searchString: string) => {
  return qs.parse(searchString, { ignoreQueryPrefix: true })
}

/**
 * Stringifies the search object with explicit URL encoding.
 * Used for API calls where special characters need to be encoded.
 * Output: ?key[0]=value1&key[1]=value2
 *
 * @param searchObject - The search object to stringify.
 * @returns The stringified search object with URL encoding.
 *
 * @example
 *     customStringifiedEncoded({ key: ['value1', 'value2'] })
 *
 */
export const customStringifiedEncoded = (searchObject: Record<string, any> | undefined | null) => {
  return Object.keys(searchObject || {}).length > 0
    ? `?${qs.stringify(searchObject, { arrayFormat: 'indices', encode: true })}`
    : ''
}

/**
 * Stringifies the search object without the leading question mark.
 * Useful when building URL parts.
 *
 * @param searchObject - The search object to stringify.
 * @returns The stringified search object without leading question mark.
 *
 * @example
 *     customStringifiedRaw({ key: ['value1', 'value2'] })
 *
 */
export const customStringifiedRaw = (searchObject: Record<string, any> | undefined | null) => {
  return Object.keys(searchObject || {}).length > 0 ? qs.stringify(searchObject, { arrayFormat: 'indices' }) : ''
}

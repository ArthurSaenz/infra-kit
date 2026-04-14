import qs from 'qs'

/**
 * @description Stringify the search object.
 * For example, we use `qs` to render arrays in bracket notation:
 * output: ?key[0]=value1&key[1]=value2
 *
 * @param searchObject - The search object to stringify.
 * @returns The stringified search object.
 */
export const customStringified = (searchObject: Record<string, any> | undefined | null) => {
  return Object.keys(searchObject || {}).length > 0 ? `?${qs.stringify(searchObject, { arrayFormat: 'indices' })}` : ''
}

/**
 * @description Parse the search string: ?key[0]=value1&key[1]=value2
 * @param searchString - The search string to parse.
 *
 * @returns The parsed search object: { key: ['value1', 'value2'] }
 */
export const customParser = (searchString: string) => {
  return qs.parse(searchString, { ignoreQueryPrefix: true })
}

/**
 * @description Stringify the search object with explicit URL encoding.
 * Used for API calls where special characters need to be encoded.
 * output: ?key[0]=value1&key[1]=value2
 *
 * @param searchObject - The search object to stringify.
 * @returns The stringified search object with URL encoding.
 */
export const customStringifiedEncoded = (searchObject: Record<string, any> | undefined | null) => {
  return Object.keys(searchObject || {}).length > 0
    ? `?${qs.stringify(searchObject, { arrayFormat: 'indices', encode: true })}`
    : ''
}

/**
 * @description Stringify the search object without the leading question mark.
 * Useful when building URL parts.
 *
 * @param searchObject - The search object to stringify.
 * @returns The stringified search object without leading question mark.
 */
export const customStringifiedRaw = (searchObject: Record<string, any> | undefined | null) => {
  return Object.keys(searchObject || {}).length > 0 ? qs.stringify(searchObject, { arrayFormat: 'indices' }) : ''
}

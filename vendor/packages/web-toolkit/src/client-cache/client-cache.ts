const noop = () => {}
const fakeLs = {
  setItem: noop,
  getItem: noop,
  removeItem: noop,
}

const _localStorage = typeof window === 'undefined' ? fakeLs : window.localStorage

const namespace = 'v1'
/**
 * Returns the namespaced localStorage key for a given cache name.
 *
 * @example
 *     getKey('user') // => 'v1.user'
 *
 * @deprecated
 */
const getKey = (name: string) => {
  return `${namespace}.${name}`
}
/**
 * Returns the namespaced localStorage key for the updatedAt timestamp of a given cache name.
 *
 * @example
 *     updatedAtKey('user') // => 'v1.user.updatedAt'
 *
 * @deprecated
 */
const updatedAtKey = (name: string) => {
  return `${namespace}.${name}.updatedAt`
}

/**
 * Asynchronously saves a value to localStorage under the given name via a deferred setTimeout.
 *
 * @example
 *     save('user', { id: 1 })
 *
 * @deprecated
 */
export const save = (name: string, value: unknown, updatedAt?: string) => {
  setTimeout(() => {
    return saveSync(name, value, updatedAt)
  }, 1)
}
/**
 * Synchronously saves a value to localStorage under the given name.
 *
 * @example
 *     saveSync('user', { id: 1 })
 *
 * @deprecated
 */
export const saveSync = (name: string, value: unknown, updatedAt?: string | undefined) => {
  if (value === undefined) {
    _localStorage.removeItem(getKey(name))
    _localStorage.removeItem(updatedAtKey(name))
  }

  _localStorage.setItem(getKey(name), JSON.stringify(value))
  _localStorage.setItem(updatedAtKey(name), updatedAt || Date.now().toString())
}
/**
 * Loads and JSON-parses a value from localStorage by name.
 *
 * @example
 *     const user = load<User>('user')
 *
 * @deprecated
 */
export const load = <T>(name: string): T | undefined => {
  const key = getKey(name)
  const string = _localStorage.getItem(key)

  let result

  if (!string) {
    return result
  }

  try {
    result = JSON.parse(string)
  } catch (error) {
    console.warn(`Cannot parse local storage value ${key}: ${string}`, error)
  }

  return result
}
/**
 * Returns the stored updatedAt timestamp string for the given name, or undefined if absent.
 *
 * @example
 *     const ts = getUpdatedAt('user')
 *
 * @deprecated
 */
const getUpdatedAt = (name: string): string | undefined => {
  const time = _localStorage.getItem(updatedAtKey(name))

  return time || undefined
}

/**
 * Returns true if a cached value exists under the given name.
 *
 * @example
 *     const exists = isExist('user')
 *
 * @deprecated
 */
export const isExist = (name: string): boolean => {
  return getUpdatedAt(name) !== undefined
}
/**
 * Returns true if a cached value exists and was stored within the given number of seconds.
 *
 * @example
 *     const fresh = isExistAndFresh('user', 300)
 *
 * @deprecated
 */
export const isExistAndFresh = (name: string, notOlderThan: number): boolean => {
  const updatedAt = getUpdatedAt(name)

  if (updatedAt === undefined) {
    return false
  }

  const t = Date.now() - 1000 * notOlderThan

  return t <= Number(updatedAt)
}

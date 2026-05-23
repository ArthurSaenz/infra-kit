const noop = () => {}
const fakeLs = {
  setItem: noop,
  getItem: noop,
  removeItem: noop,
}

const _localStorage = typeof window === 'undefined' ? fakeLs : window.localStorage

const namespace = 'v1'
/**
 * @deprecated
 */
const getKey = (name: string) => {
  return `${namespace}.${name}`
}
/**
 * @deprecated
 */
const updatedAtKey = (name: string) => {
  return `${namespace}.${name}.updatedAt`
}

/**
 * @deprecated
 */
export const save = (name: string, value: unknown, updatedAt?: string) => {
  setTimeout(() => {
    return saveSync(name, value, updatedAt)
  }, 1)
}
/**
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
 * @deprecated
 */
const getUpdatedAt = (name: string): string | undefined => {
  const time = _localStorage.getItem(updatedAtKey(name))

  return time || undefined
}

/**
 * @deprecated
 */
export const isExist = (name: string): boolean => {
  return getUpdatedAt(name) !== undefined
}
/**
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

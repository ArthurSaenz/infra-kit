/*
 * https://github.com/niketpathak/localstorage-slim
 */

const isObject = (item: any): boolean => {
  return item !== null && item.constructor.name === 'Object'
}

// private flags
let hasLS: boolean

const supportsLS = (): boolean => {
  if (typeof hasLS !== 'undefined') return hasLS
  hasLS = true

  try {
    if (!localStorage) {
      hasLS = false
    }
    // eslint-disable-next-line sonarjs/no-ignored-exceptions, unused-imports/no-unused-vars
  } catch (error) {
    // some browsers throw an error if you try to access local storage (e.g. brave browser)
    // and some like Safari do not allow access to LS in incognito mode
    hasLS = false
  }

  // flush once on init
  flush()

  return hasLS
}

// Apex
const APX = String.fromCharCode(0)

/**
 * @param {string} key - A key to identify the value.
 * @param {any} value - A value associated with the key.
 * @param {number} ttl - Time to live in seconds.
 */
export const set = <T = unknown>(key: string, value: T, ttl: number | null = null): void | boolean => {
  if (!supportsLS()) return false

  try {
    const hasTTL = ttl && !Number.isNaN(ttl) && ttl > 0
    const _value = hasTTL ? { [APX]: value, ttl: Date.now() + (ttl as number) * 1e3 } : value

    localStorage.setItem(key, JSON.stringify(_value))
  } catch (error) {
    // Sometimes stringify fails due to circular refs
    console.error(error)

    return false
  }
}

/**
 * @param {string} key - A key to identify the data.
 * @returns {any|null} returns the value associated with the key if its exists and is not expired. Returns `null` otherwise
 */
export const get = <T = unknown>(key: string): T | null => {
  if (!supportsLS()) return null

  const string = localStorage.getItem(key)

  if (!string) {
    return null
  }

  const data = parseData<T>(key, string)

  return data
}

export const parseData = <T>(key: string, string: string): T | null => {
  const item = JSON.parse(string)
  const hasTTL = isObject(item) && APX in item

  // if not using ttl, return immediately
  if (!hasTTL) {
    return item
  }

  if (Date.now() > item.ttl) {
    localStorage.removeItem(key)

    return null
  }

  return item[APX]
}

export const flush = (force = false): false | void => {
  if (!supportsLS()) return false

  Object.keys(localStorage).forEach((key) => {
    const string = localStorage.getItem(key)

    if (!string) return // continue iteration

    let item

    try {
      item = JSON.parse(string)
      // eslint-disable-next-line sonarjs/no-ignored-exceptions, unused-imports/no-unused-vars
    } catch (error) {
      // Some packages write strings to localStorage that are not converted by JSON.stringify(), so we need to ignore it
      return
    }
    // flush only if ttl was set and is/is not expired
    if (isObject(item) && APX in item && (Date.now() > item.ttl || force)) {
      localStorage.removeItem(key)
    }
  })
}

export const remove = (key: string): undefined | false => {
  if (!supportsLS()) return false

  localStorage.removeItem(key)
}

export const clear = (): undefined | false => {
  if (!supportsLS()) return false

  localStorage.clear()
}

import * as idb from 'idb-keyval'

/**
 * https://github.com/sach2211/idbcache
 */

/**
 * @param {string} key - A key to identify the value.
 * @param {any} value - A value associated with the key.
 * @param {number} ttl - Time to live in seconds.
 */
export const set = async <T>(key: string, value: T, ttl: number) => {
  try {
    const timeToExpire = Date.now() + ttl * 1000

    await Promise.all([idb.set(key, value), idb.set(`__ExpiryTimeStamp__${key}`, timeToExpire)])

    // Once the keys are set, remove any expired keys.
    removeExpiredKeys()
  } catch (error) {
    console.error(error)
  }
}

/**
 * @param {string} key - A key to identify the data.
 * @returns {any|null} returns the value associated with the key if its exists and is not expired. Returns `null` otherwise
 */
export const get = async <T = unknown>(key: IDBValidKey): Promise<T | null> => {
  try {
    if (isInternalExpiryTimestampKey(key)) {
      const payload = await idb.get(key)

      return payload
    }

    const timeStamp = await idb.get(`__ExpiryTimeStamp__${key}`)

    if (timeStamp > Date.now()) {
      const data = await idb.get(key)

      return data
    }
    // Key has expired => delete it and return null;
    remove(key)

    return null
  } catch (error) {
    console.error(error)

    return null
  }
}

export const remove = (key: IDBValidKey) => {
  // Delete a specific key and its timestamp key.
  if (isInternalExpiryTimestampKey(key)) {
    // if trying to delete the expiryTimeStamp key, delete the original key as well.
    idb.del(key)
    idb.del((key as string).slice('__ExpiryTimeStamp__'.length))
  } else {
    // if trying to delete the original key, delete the expiryTimeStamp key as well.
    idb.del(key)
    idb.del(`__${key}ExpiryTimeStamp`)
  }
}

export const flush = () => {
  idb.clear()
}

const all = () => {
  return idb.keys()
}

const isInternalExpiryTimestampKey = (key: IDBValidKey) => {
  // timestamp keys have following format : '__<key>ExpiryTimeStamp'
  return (key as string).match(/__ExpiryTimeStamp__\w*/g)
}

const getAllInternalTimestampKeys = async (): Promise<IDBValidKey[] | null> => {
  try {
    const keys = await all()

    const internalKeys = keys.filter((thisKey: IDBValidKey) => {
      return isInternalExpiryTimestampKey(thisKey as string) ? thisKey : false
    })

    return internalKeys
  } catch (error) {
    console.error(error)

    return null
  }
}

export const removeExpiredKeys = async () => {
  try {
    const keys = await getAllInternalTimestampKeys()

    if (!keys) return

    const p = keys.map(async (thisKey: IDBValidKey) => {
      return get(thisKey).then((value) => {
        return Date.now() > (value as number) ? remove(thisKey) : null
      })
    })

    await Promise.all(p)
  } catch (error) {
    console.error(error)
  }
}

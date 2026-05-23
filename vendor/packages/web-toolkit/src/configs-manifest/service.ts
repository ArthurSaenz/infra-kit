import { atom, useSetAtom } from 'jotai'
import { useEffect } from 'react'

import type { HttpClient } from '../http-client'
import { idb } from '../idb-slim'
import { ls } from '../ls-slim'
import { isSSR } from '../ssr'

const THROTTLE_TIME_IN_SECONDS = 60 * 60 * 24 * 7 // 7 days
const LS_DEBUG_MANIFEST_CACHE_STATUS = 'LS_DEBUG_MANIFEST_CACHE_STATUS'

/**
 * @description Counter that triggers config data refetch when incremented. Used in mobile app when:
 * - User returns from background
 * - User clicks on notification
 */
const $configRefetchTrigger = atom(0)

/**
 * @description Loading state for config data refetch. Used to show loader when refetching config data.
 */
const $configRefetchLoading = atom(false)

interface CreateConfigAtomProps {
  manifestFileUrl: string
  httpClient: HttpClient
  isEnabledDebug: boolean
  updateLastConfigRefetch?: () => void
}

export const create = <T>(args: CreateConfigAtomProps) => {
  const { manifestFileUrl, httpClient, isEnabledDebug, updateLastConfigRefetch } = args

  const $config = atom<Promise<T | null>>(async (get) => {
    // INFO: only trigger when the app is active

    get($configRefetchTrigger)

    const configData = await fetchRootManifest<T>({ url: manifestFileUrl, httpClient, isEnabledDebug })

    return configData
  })

  const refetchConfigData = atom(null, async (get, set) => {
    set($configRefetchLoading, true)

    try {
      set($configRefetchTrigger, (prev) => {
        return prev + 1
      })

      await new Promise((resolve) => {
        return setTimeout(resolve, 30)
      })

      await get($config)

      // Track successful config refetch timestamp
      updateLastConfigRefetch?.()
    } finally {
      set($configRefetchLoading, false)
    }
  })

  const InitDebugManifestCache = (props: { isEnabledDebug: boolean }) => {
    const { isEnabledDebug } = props

    const _refetchConfigData = useSetAtom(refetchConfigData)

    useEffect(() => {
      if (isEnabledDebug) {
        attachDebugManifestCache({ refetchConfigData: _refetchConfigData })
      }
    }, [])

    return null
  }

  /**
   * Retrieves configuration data from a specified URL. Generic function.
   * Used for config-manifest and other config files (mobile-versions in force-update, etc.)
   *
   * @param key - The key used to identify the configuration data.
   * @param url - The URL from which to fetch the configuration data.
   * @returns A promise that resolves to the fetched configuration data.
   * @throws An error if the URL is undefined or if there is an error during the fetch operation.
   */
  const fetchManifestConfigFile = getManifestConfigFile({ httpClient, isEnabledDebug })

  return { $config, refetchConfigData, InitDebugManifestCache, fetchManifestConfigFile, $configRefetchLoading } as const
}

const fetchRootManifest = async <T>(args: {
  url: string
  httpClient: HttpClient
  isEnabledDebug: boolean
}): Promise<T | null> => {
  const { url, httpClient, isEnabledDebug } = args

  if (!url) {
    throw new Error('Manifest file URL is not defined')
  }

  if (!httpClient) {
    throw new Error('HTTP client is not defined')
  }

  if (isSSR) return Promise.resolve(null)

  try {
    const cacheKey = `rootManifest:${url}.cacheData`
    const cachedData = await idb.get<{ etag: string; data: T }>(cacheKey)
    const isValidateCache = Boolean(cachedData?.etag && cachedData?.data)

    const response = await httpClient.fetch<T>(url, {
      method: 'GET',
      headers: isValidateCache && cachedData ? { 'If-None-Match': cachedData.etag } : undefined,
    })

    if (response.status === 304 && cachedData) {
      if (isEnabledDebug) {
        // eslint-disable-next-line no-console
        console.log('App manifest config (304, cached):', url, cachedData.data)
      }

      return cachedData.data
    }

    if (response.headers?.etag && response.body) {
      await idb.set(cacheKey, { etag: response.headers.etag, data: response.body }, THROTTLE_TIME_IN_SECONDS)
    }

    if (isEnabledDebug) {
      // eslint-disable-next-line no-console
      console.log('App manifest config:', url, response.body)
    }

    return response.body
  } catch (error) {
    console.error('fetchRootManifest', error)

    return null
  }
}

const getManifestConfigFile = ({ httpClient, isEnabledDebug }: { httpClient: HttpClient; isEnabledDebug: boolean }) => {
  return async <T>(key: string, url?: string, isAllowDebug = false): Promise<T> => {
    if (isSSR) {
      throw new Error(`Manifest config file URL of ${key} cannot be fetched during SSR`)
    }

    try {
      const cacheKey = `${key}.cacheData`

      const cachedData = await idb.get<{ etag: string; data: T }>(cacheKey)

      if (isAllowDebug && cachedData) {
        const status = ls.get(LS_DEBUG_MANIFEST_CACHE_STATUS)

        if (status === 'disabled') {
          cachedData.etag = ''
        }
      }

      if (isEnabledDebug) {
        // eslint-disable-next-line no-console
        console.info('Manifest config file:', {
          cachedData,
          key,
          url,
        })
      }

      if (!url) {
        throw new Error(`Manifest config file URL of ${key} is undefined`)
      }

      const isValidateCache = cachedData?.etag && cachedData?.data

      const response = await httpClient.fetch<T>(url, {
        method: 'GET',
        headers: isValidateCache
          ? {
              'If-None-Match': cachedData.etag,
            }
          : undefined,
      })

      if (response.status === 304 && isValidateCache) {
        const payload = cachedData.data as T

        return payload
      }

      if (isEnabledDebug) {
        // eslint-disable-next-line no-console
        console.info('Manifest config file:', key, response.headers)
      }

      if (response.headers?.etag && response.body) {
        await idb.set(cacheKey, { etag: response.headers?.etag, data: response.body }, THROTTLE_TIME_IN_SECONDS)
      }

      return response.body
    } catch (error) {
      console.error('getManifestConfigFile', error)

      throw error
    }
  }
}

const attachDebugManifestCache = (args: { refetchConfigData: () => void }) => {
  const { refetchConfigData } = args

  window._app = window._app || {}
  window._app.manifestCache = {
    enable: () => {
      ls.remove(LS_DEBUG_MANIFEST_CACHE_STATUS)
      // eslint-disable-next-line no-console
      console.log('Refresh the page!')
    },
    disable: () => {
      ls.set(LS_DEBUG_MANIFEST_CACHE_STATUS, 'disabled')
      // eslint-disable-next-line no-console
      console.log('Refresh the page!')
    },
    refetchConfigData,
  }
}

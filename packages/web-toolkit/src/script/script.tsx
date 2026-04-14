import { useEffect, useRef } from 'react'

import { requestIdleCallback } from './request-idle-callback'

const ScriptCache = new Map()
const LoadCache = new Set()

const DOMAttributeNames: Record<string, string> = {
  acceptCharset: 'accept-charset',
  className: 'class',
  htmlFor: 'for',
  httpEquiv: 'http-equiv',
  noModule: 'noModule',
}

type ScriptProps = React.ScriptHTMLAttributes<HTMLScriptElement> & {
  strategy?: 'afterInteractive' | 'lazyOnload'
  id?: string
  onLoad?: (e: any) => void
  onReady?: () => void | null
  onError?: (e: any) => void
  children?: React.ReactNode
  shouldUnMountScript?: boolean
  onUnMount?: () => void
}

const ignoreProps = [
  'onLoad',
  'onReady',
  'dangerouslySetInnerHTML',
  'children',
  'onError',
  'strategy',
  'shouldUnMountScript',
  'onUnMount',
]

const loadScript = (props: ScriptProps): void => {
  const { src, id, onLoad = () => {}, onReady = null, dangerouslySetInnerHTML, children = '', onError } = props

  const cacheKey = id || src

  // Script has already loaded
  if (cacheKey && LoadCache.has(cacheKey)) {
    return
  }

  // Contents of this script are already loading/loaded
  if (ScriptCache.has(src)) {
    LoadCache.add(cacheKey)
    // It is possible that multiple `next/script` components all have same "src", but has different "onLoad"
    // This is to make sure the same remote script will only load once, but "onLoad" are executed in order
    ScriptCache.get(src).then(onLoad, onError)

    return
  }

  /** Execute after the script first loaded */
  const afterLoad = () => {
    // Run onReady for the first time after load event
    if (onReady) {
      onReady()
    }
    // add cacheKey to LoadCache when load successfully
    LoadCache.add(cacheKey)
  }

  const element = document.createElement('script')

  const loadPromise = new Promise<void>((resolve, reject) => {
    element.addEventListener('load', function (e) {
      resolve()

      onLoad.call(this, e)

      afterLoad()
    })

    element.addEventListener('error', (e) => {
      reject(e)
    })
  }).catch((error) => {
    if (onError) {
      onError(error)
    }
  })

  if (dangerouslySetInnerHTML) {
    element.innerHTML = dangerouslySetInnerHTML.__html.toString() || ''

    afterLoad()
  } else if (children) {
    // eslint-disable-next-line sonarjs/no-nested-conditional
    element.textContent = typeof children === 'string' ? children : Array.isArray(children) ? children.join('') : ''

    afterLoad()
  } else if (src) {
    element.src = src
    // do not add cacheKey into LoadCache for remote script here
    // cacheKey will be added to LoadCache when it is actually loaded (see loadPromise above)

    ScriptCache.set(src, loadPromise)
  }

  for (const [k, value] of Object.entries(props)) {
    if (value === undefined || ignoreProps.includes(k)) {
      continue
    }

    const attr = DOMAttributeNames[k] || k.toLowerCase()

    element.setAttribute(attr, value)
  }

  document.body.appendChild(element)
}

function loadLazyScript(props: ScriptProps) {
  if (document.readyState === 'complete') {
    requestIdleCallback(() => {
      return loadScript(props)
    })
  } else {
    window.addEventListener('load', () => {
      requestIdleCallback(() => {
        return loadScript(props)
      })
    })
  }
}

// export function handleClientScriptLoad(props: ScriptProps) {
//   const { strategy = 'afterInteractive' } = props
//   if (strategy === 'lazyOnload') {
//     window.addEventListener('load', () => {
//       requestIdleCallback(() => loadScript(props))
//     })
//   } else {
//     loadScript(props)
//   }
// }

// export function initScriptLoader(scriptLoaderItems: ScriptProps[]) {
//   scriptLoaderItems.forEach(handleClientScriptLoad)
// }

function removeScript(props: ScriptProps) {
  const { src, id } = props

  const cacheKey = id || src

  document.querySelector(`#${props.id}`)?.remove()

  ScriptCache.delete(src)
  LoadCache.delete(cacheKey)
}

export function Script(props: ScriptProps): React.ReactElement | null {
  const { id, src = '', onReady = null, strategy = 'afterInteractive', shouldUnMountScript, onUnMount } = props

  /**
   * - First mount:
   *   1. The useEffect for onReady executes
   *   2. hasOnReadyEffectCalled.current is false, but the script hasn't loaded yet (not in LoadCache)
   *      onReady is skipped, set hasOnReadyEffectCalled.current to true
   *   3. The useEffect for loadScript executes
   *   4. hasLoadScriptEffectCalled.current is false, loadScript executes
   *      Once the script is loaded, the onLoad and onReady will be called by then
   *   [If strict mode is enabled / is wrapped in <OffScreen /> component]
   *   5. The useEffect for onReady executes again
   *   6. hasOnReadyEffectCalled.current is true, so entire effect is skipped
   *   7. The useEffect for loadScript executes again
   *   8. hasLoadScriptEffectCalled.current is true, so entire effect is skipped
   *
   * - Second mount:
   *   1. The useEffect for onReady executes
   *   2. hasOnReadyEffectCalled.current is false, but the script has already loaded (found in LoadCache)
   *      onReady is called, set hasOnReadyEffectCalled.current to true
   *   3. The useEffect for loadScript executes
   *   4. The script is already loaded, loadScript bails out
   *   [If strict mode is enabled / is wrapped in <OffScreen /> component]
   *   5. The useEffect for onReady executes again
   *   6. hasOnReadyEffectCalled.current is true, so entire effect is skipped
   *   7. The useEffect for loadScript executes again
   *   8. hasLoadScriptEffectCalled.current is true, so entire effect is skipped
   */
  const hasOnReadyEffectCalled = useRef(false)

  useEffect(() => {
    const cacheKey = id || src

    if (!hasOnReadyEffectCalled.current) {
      // Run onReady if script has loaded before but component is re-mounted
      if (onReady && cacheKey && LoadCache.has(cacheKey)) {
        onReady()
      }

      hasOnReadyEffectCalled.current = true
    }
  }, [onReady, id, src])

  useEffect(() => {
    if (strategy === 'afterInteractive') {
      loadScript(props)
    }

    if (strategy === 'lazyOnload') {
      loadLazyScript(props)
    }

    if (shouldUnMountScript) {
      return () => {
        removeScript(props)
        onUnMount?.()
      }
    }
  }, [])

  return null
}

Object.defineProperty(Script, '__customScript', { value: true })

export const requestIdleCallback =
  // eslint-disable-next-line no-restricted-globals
  (typeof self !== 'undefined' && self.requestIdleCallback && self.requestIdleCallback.bind(window)) ||
  function (callback: IdleRequestCallback): number {
    const start = Date.now()

    return setTimeout(() => {
      callback({
        didTimeout: false,
        timeRemaining() {
          return Math.max(0, 50 - (Date.now() - start))
        },
      })
    }, 1) as unknown as number
  }

export const cancelIdleCallback =
  // eslint-disable-next-line no-restricted-globals
  (typeof self !== 'undefined' && self.cancelIdleCallback && self.cancelIdleCallback.bind(window)) ||
  function (id: number) {
    return clearTimeout(id)
  }

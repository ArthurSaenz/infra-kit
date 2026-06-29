import type { BaseLayoutProps } from 'fumadocs-ui/layouts/shared'

/**
 * White-label base layout options. The consuming app passes its own brand name so the
 * template carries no hardcoded title.
 *
 * @example
 *     const opts = baseOptions('My App')
 *
 */
export const baseOptions = (appName: string): BaseLayoutProps => {
  return {
    nav: {
      title: appName,
    },
  }
}

export const FEATURE_PREFIX = 'feature/'

/**
 * Normalize a feature name to its branch, accepting it with or without the prefix.
 *
 * @example
 * toFeatureBranch(' Checkout V2 ') // => 'feature/checkout-v2'
 * toFeatureBranch('feature/checkout-v2') // => 'feature/checkout-v2'
 */
export const toFeatureBranch = (name: string): string => {
  const slug = name
    .trim()
    .replace(/^feature\//, '')
    .toLowerCase()
    .replaceAll(/\s+/g, '-')

  return `${FEATURE_PREFIX}${slug}`
}

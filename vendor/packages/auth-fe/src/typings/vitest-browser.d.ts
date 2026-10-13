// `expect.element` is a `declare module 'vitest'` augmentation shipped in @vitest/browser/matchers.
// The workspace pulled it in through a peer-resolved vitest instance; the deploy's pruned tree
// resolves another instance and the tests stopped type-checking there (`tsc -b` builds them).
/// <reference types="@vitest/browser/matchers" />

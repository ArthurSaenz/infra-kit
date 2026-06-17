// VIOLATION: reaches into feature "alpha" internals (depth 2), bypassing the barrel.
import { Widget } from '#root/features/alpha/components/Widget'

export const fromAlphaWidget = Widget

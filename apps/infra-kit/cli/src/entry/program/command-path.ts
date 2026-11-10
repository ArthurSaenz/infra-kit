import type { Command } from 'commander'

/**
 * Canonical space-joined command path for a leaf (e.g. the `check` leaf of `vendor` → "vendor check").
 * Stops at the root program (a node with no parent) so its name — the bin basename like "cli" — never
 * leaks into the equivalent line.
 */
export const commandPath = (leaf: Command): string => {
  const parts: string[] = []

  for (let node: Command | null = leaf; node && node.parent; node = node.parent) {
    parts.unshift(node.name())
  }

  return parts.join(' ')
}

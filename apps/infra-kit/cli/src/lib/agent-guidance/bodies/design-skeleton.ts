/**
 * Skeleton for a package's `DESIGN.md`, in the shape of the Google Labs
 * `design.md` spec: YAML front matter (`name`, `description`, `colors`,
 * `typography`, `rounded`, `spacing`, `components`) followed by the prose
 * sections in spec order.
 *
 * Every value is a placeholder a human replaces — infra-kit cannot author brand
 * content, so the skeleton exists to give that content a home and a shape, not
 * to be correct on its own. Nothing in the CLI parses this file, and the spec it
 * follows is self-declared alpha, so this is a starting point rather than a
 * contract. `audit --fix --design` writes it only for `frontend` / `mobile`
 * packages and never overwrites an existing file.
 *
 * @example
 * buildDesignSkeleton('@hulyo/client-ui')
 * // => '---\nname: @hulyo/client-ui\n…'
 */
export const buildDesignSkeleton = (packageName: string): string => {
  return [
    '---',
    `name: ${packageName}`,
    'description: TODO — one sentence describing the product surface this package renders.',
    'colors:',
    "  primary: '#2563eb'",
    "  secondary: '#64748b'",
    "  background: '#ffffff'",
    "  surface: '#f8fafc'",
    "  text: '#0f172a'",
    "  muted: '#64748b'",
    "  border: '#e2e8f0'",
    "  success: '#16a34a'",
    "  warning: '#d97706'",
    "  danger: '#dc2626'",
    'typography:',
    '  fontFamily: TODO — the UI typeface stack.',
    '  scale: [12, 14, 16, 20, 24, 32, 40]',
    '  weights: [400, 500, 600, 700]',
    'rounded: 8px',
    'spacing: [4, 8, 12, 16, 24, 32, 48]',
    'components:',
    '  - button',
    '  - input',
    '  - card',
    '  - dialog',
    '---',
    '',
    `# Design — ${packageName}`,
    '',
    'Replace every TODO below with the real design language. This file is the source of truth',
    'for UI decisions in this package; agents are instructed to read it before styling anything.',
    '',
    '## Overview',
    '',
    'TODO — what this product is, who uses it, and the feeling the interface should convey.',
    '',
    '## Colors',
    '',
    'TODO — what each token in the front matter means and when to reach for it. Name the',
    'contrast pairs that are guaranteed accessible.',
    '',
    '## Typography',
    '',
    'TODO — the typeface, the scale, and which size and weight each role uses',
    '(page title, section title, body, caption, label).',
    '',
    '## Layout',
    '',
    'TODO — the grid, the page gutters, the maximum content width, and the breakpoints.',
    '',
    '## Elevation & Depth',
    '',
    'TODO — the shadow levels and what sits at each one (base, raised, overlay, modal).',
    '',
    '## Shapes',
    '',
    'TODO — corner radii per component size, border widths, and where a shape is square by intent.',
    '',
    '## Components',
    '',
    'TODO — for each component in the front matter list: its variants, its states',
    '(default, hover, active, focus, disabled, loading), and its sizes.',
    '',
    "## Do's and Don'ts",
    '',
    '- Do TODO.',
    '- Do TODO.',
    "- Don't TODO.",
    "- Don't TODO.",
    '',
  ].join('\n')
}

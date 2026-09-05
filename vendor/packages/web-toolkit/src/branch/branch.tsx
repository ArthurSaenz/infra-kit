import { Children } from 'react'

interface BranchProps {
  if: boolean
  children: React.ReactNode
}

/**
 * This is a declarative component for conditional rendering.
 *
 * The first child renders when `if` is true, the second when it is false; pass a single
 * child and the false branch renders nothing.
 *
 * @param props
 * @param props.if - The boolean value.
 * @param props.children - The two component for rendering.
 * @return A correct render component
 * @example
 *     <Branch if={value}>
 *       <div>True component</div>
 *       <div>False component</div>
 *     </Branch>
 *     // => value ? <div>True component</div> : <div>False component</div>
 */
export const Branch = (props: BranchProps) => {
  const { if: value, children } = props

  const [thenBranch, elseBranch, ...another] = Children.toArray(children)
  const result = value ? thenBranch : elseBranch

  if (another.length > 0) {
    throw new TypeError(
      'You passed more than two children to Branch. Maybe you forgot to wrap multiple children to <React.Fragment /> ?',
    )
  }

  return <>{result}</> || null
}

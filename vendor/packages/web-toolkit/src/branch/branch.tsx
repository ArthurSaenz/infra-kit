import { Children } from 'react'

interface BranchProps {
  if: boolean
  children: React.ReactNode
}

/**
 * This is a declarative component for conditional rendering.
 *
 * @param {object} props
 * @param {boolean} props.if - The boolean value.
 * @param props.children - The two component for rendering.
 * @return {(null | object)} A correct render component
 *
 * @example
 *     <Branch if={true}>
 *        <div>True component</div>
 *        <div>False component</div>
 *     </Branch>
 *     // =>  <div>True component</div>
 * @example
 *     <Branch if={false}>
 *        <div>Primary component</div>
 *     </Branch>
 *     // =>  null
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

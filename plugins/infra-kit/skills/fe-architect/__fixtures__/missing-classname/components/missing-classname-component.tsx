import type { MissingClassnameComponentProps } from '../types'

export const MissingClassnameComponent = (props: MissingClassnameComponentProps) => {
  const { label } = props

  return <div>{label}</div>
}

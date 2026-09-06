// Inline type modifier - erased at compile time, so NOT a runtime dependency.
import { type ProviderData } from '#root/features/provider'

export const ConsumerContainer = (props: { data: ProviderData }) => {
  const { data } = props

  return <div>{data.id}</div>
}

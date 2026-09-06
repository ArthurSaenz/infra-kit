import { cn } from '@wl/web-toolkit'
import type { PropsInTypesComponentProps } from '../types'

export const PropsInTypesComponent = (props: PropsInTypesComponentProps) => {
  const { label, className } = props

  return <div className={cn('p-2', className)}>{label}</div>
}

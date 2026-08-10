import { cn } from '@wl/web-toolkit'
import type { ValidComponentProps } from '../types'

export const ValidComponent = (props: ValidComponentProps) => {
  const { data, className } = props

  return <div className={cn('p-4', className)}>{data.id}</div>
}

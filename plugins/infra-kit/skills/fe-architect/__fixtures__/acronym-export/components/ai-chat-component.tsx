import { cn } from '@wl/web-toolkit'

import type { AIChatComponentProps } from '../types'

export const AIChatComponent = (props: AIChatComponentProps) => {
  const { data, className } = props

  return <div className={cn('p-4', className)}>{data.id}</div>
}

import { useAtomValue } from 'jotai'
import { ValidComponent } from '../components/valid-component'
import * as service from '../services'

export const ValidContainer = () => {
  const data = useAtomValue(service.$data)
  const isLoading = useAtomValue(service.$isLoading)
  const error = useAtomValue(service.$error)

  if (isLoading && !data) return <span>loading</span>
  if (error) return <span>error</span>
  if (!data) return <span>empty</span>

  return <ValidComponent data={data} />
}

import { useAtomValue } from 'jotai'

import { ConnectionBannerComponent } from '../components/connection-banner-component'
import * as service from '../services'

export const ConnectionBannerContainer = () => {
  const connection = useAtomValue(service.$connection)

  return <ConnectionBannerComponent status={connection.status} lastUpdate={connection.lastUpdate} />
}

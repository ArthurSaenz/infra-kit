import '@xyflow/react/dist/style.css'
import { createRoot } from 'react-dom/client'

import { AtlasPage } from './pages/atlas-page'
import './styles.css'

const root = document.getElementById('atlas-root')

if (root !== null) createRoot(root).render(<AtlasPage />)

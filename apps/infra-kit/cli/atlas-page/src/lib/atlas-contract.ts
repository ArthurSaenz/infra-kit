// The one module that reaches into the CLI's source: the runner and the page share the wire contract.
export { ATLAS_CONTRACT_VERSION, ATLAS_RUN_FOLDER_ID } from '../../../src/dev/atlas/atlas-contract'
export type {
  AtlasBackend,
  AtlasLog,
  AtlasReason,
  AtlasRoute,
  AtlasServed,
  AtlasSite,
  AtlasSnapshot,
} from '../../../src/dev/atlas/atlas-contract'

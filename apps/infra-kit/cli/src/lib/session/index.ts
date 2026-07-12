export { equivalentLine } from './equivalent'
export type { EquivalentLine } from './equivalent'
export { formatRunHeader, formatTranscriptEntry } from './format-entry'
export type { TranscriptEntryInput } from './format-entry'
export { classifyOutcome } from './outcome'
export type { SessionOutcome } from './outcome'
export {
  addSessionSummary,
  captureSessionReportPath,
  isSessionChild,
  newReportPath,
  readAndUnlinkReport,
  SESSION_REPORT_ENV,
  writeSessionReport,
} from './report'
export type { SessionReportRecord } from './report'
export { resetTerminal } from './reset-terminal'
export type { ResetTerminalDeps } from './reset-terminal'
export { runSession, sessionGateEnabled } from './run-session'
export type { RunSessionDeps, SessionCommand, SessionPaletteItem } from './run-session'

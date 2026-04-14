export interface ToolsExecutionResult {
  [x: string]: unknown
  content: {
    type: 'text'
    text: string
  }[]
  structuredContent?: { [x: string]: unknown }
}

export interface RequiredConfirmedOptionArg {
  confirmedCommand: boolean
}

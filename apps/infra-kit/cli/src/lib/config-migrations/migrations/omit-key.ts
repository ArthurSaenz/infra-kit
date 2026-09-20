export const omitKey = (record: Record<string, unknown>, key: string): Record<string, unknown> => {
  return Object.fromEntries(
    Object.entries(record).filter(([entryKey]) => {
      return entryKey !== key
    }),
  )
}

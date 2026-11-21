const pad = (value: number): string => {
  return String(value).padStart(2, '0')
}

export const formatClock = (date: Date): string => {
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
}

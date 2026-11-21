/** Joins the truthy class names; a template literal's leading space is what the class-string lint fix strips. */
export const cx = (...names: Array<string | false | null | undefined>): string => {
  return names.filter(Boolean).join(' ')
}

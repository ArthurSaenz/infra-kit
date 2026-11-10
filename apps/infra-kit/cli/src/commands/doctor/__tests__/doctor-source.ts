import fs from 'node:fs'
import path from 'node:path'

const DOCTOR_DIR = path.join(__dirname, '..')

/**
 * Every source file the doctor command is made of, as one text: `doctor.ts`, its sibling modules and
 * `checks/*`. The source guards assert properties of the COMMAND ("doctor never reaches the install
 * recipes"), so they must read all of it — reading `doctor.ts` alone would go vacuous the day a check
 * moves to another file.
 */
export const readDoctorSource = (): string => {
  const files = fs.readdirSync(DOCTOR_DIR, { recursive: true, encoding: 'utf-8' }).filter((file) => {
    return file.endsWith('.ts') && !file.includes('__tests__')
  })

  return files
    .sort()
    .map((file) => {
      return fs.readFileSync(path.join(DOCTOR_DIR, file), 'utf-8')
    })
    .join('\n')
}

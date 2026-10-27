/** Result of a single validation check against one package. */
export interface PackageCheck {
  /** Stable identifier for the check, e.g. `infra-kit.config.ts`, `script:build`. */
  name: string
  /** `warn` reports drift without failing the audit: only `fail` makes `passed` false. */
  status: 'pass' | 'warn' | 'fail'
  message: string
}

/** Aggregate validation outcome for one package directory. */
export interface PackageValidationResult {
  packageDir: string
  packageName: string
  checks: PackageCheck[]
  passed: boolean
}

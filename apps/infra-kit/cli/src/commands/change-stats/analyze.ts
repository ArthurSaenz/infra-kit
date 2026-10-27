export type CommitClass = 'agent' | 'human'

export interface ParsedCommit {
  hash: string
  /** Committer time, epoch seconds — when the change landed on the branch, not when it was written. */
  committedAt: number
  subject: string
  body: string
  files: string[]
}

export interface Rate {
  hits: number
  n: number
  rate: number | null
  ci95: { low: number; high: number } | null
}

export interface ClassStats {
  commits: number
  reverts: number
  changes: number
  revertRate: Rate
  followUpFixRate: Rate
}

export interface MetricComparison {
  suppressed: boolean
  reason: string | null
  difference: number | null
  intervalsOverlap: boolean | null
}

export const MIN_COMPARISON_N = 30
export const FOLLOW_UP_WINDOW_HOURS = 72

const FOLLOW_UP_WINDOW_SECONDS = FOLLOW_UP_WINDOW_HOURS * 3600
const Z_95 = 1.959_963_984_540_054

const AGENT_TRAILER_PATTERNS = [/^co-authored-by:\s*claude\b/imu, /^claude-session:/imu]

/**
 * Subject-only, word-bounded: `fix`, `fixes`, `fixed`, `hotfix`, `bugfix`, `regression`. The fleet does
 * not use conventional-commit types (`[DO] …`, `[FE] …` area prefixes instead), so a `^fix:` anchor would
 * miss nearly every real fix; the word boundary keeps `prefix`, `fixture` and `suffix` out. Bodies are
 * ignored because agent bodies routinely say "fixes the X case" about a feature commit.
 */
export const FIX_SUBJECT_PATTERN = /\b(?:fix(?:es|ed)?|hotfix|bugfix|regression)\b/iu

/**
 * Files every kind of commit touches, so sharing one says nothing about the earlier change being wrong —
 * a dependency fix would otherwise "follow up" every commit that moved the lockfile that week.
 */
export const FOLLOW_UP_IGNORED_FILES = ['pnpm-lock.yaml', 'package-lock.json', 'yarn.lock', 'bun.lockb', 'CHANGELOG.md']

const REVERT_SHA_PATTERN = /This reverts commit ([0-9a-f]{7,40})/u
// GitHub's revert button appends the revert PR's own number: `Revert "X (#1380)" (#1381)`.
const REVERT_SUBJECT_PATTERN = /^Revert "(.*)"(?: \(#\d+\))?$/u

const RECORD_SEPARATOR = '\u001E'
const FIELD_SEPARATOR = '\u001F'

/** `git log` format whose records {@link parseGitLog} reads; `--name-only` appends the files to each. */
export const GIT_LOG_FORMAT = `--format=${RECORD_SEPARATOR}%H${FIELD_SEPARATOR}%ct${FIELD_SEPARATOR}%B${FIELD_SEPARATOR}`

export const parseGitLog = (stdout: string): ParsedCommit[] => {
  return stdout
    .split(RECORD_SEPARATOR)
    .filter((record) => {
      return record.trim() !== ''
    })
    .map((record) => {
      const [hash = '', committedAt = '0', body = '', filesBlock = ''] = record.split(FIELD_SEPARATOR)
      const trimmedBody = body.trim()

      return {
        hash,
        committedAt: Number(committedAt),
        subject: trimmedBody.split('\n')[0] ?? '',
        body: trimmedBody,
        files: filesBlock
          .split('\n')
          .map((line) => {
            return line.trim()
          })
          .filter(Boolean),
      }
    })
}

const classifyCommit = (commit: ParsedCommit): CommitClass => {
  return AGENT_TRAILER_PATTERNS.some((pattern) => {
    return pattern.test(commit.body)
  })
    ? 'agent'
    : 'human'
}

/**
 * Keyed on the subject alone: a squash-merged PR that reverted something mid-branch carries
 * `This reverts commit …` in its BODY while being an ordinary change (measured on hulyo: 15 of 16
 * body-matches were such squashes).
 */
const isRevertCommit = (commit: ParsedCommit): boolean => {
  return REVERT_SUBJECT_PATTERN.test(commit.subject)
}

const isFixCommit = (commit: ParsedCommit): boolean => {
  return !isRevertCommit(commit) && FIX_SUBJECT_PATTERN.test(commit.subject)
}

/**
 * Wilson score interval at 95%. Chosen over the normal approximation because the rates here sit near 0
 * with small `n`, where `p ± z·√(p(1-p)/n)` collapses to a zero-width interval at `p = 0`.
 */
export const wilsonInterval = (hits: number, n: number): { low: number; high: number } | null => {
  if (n === 0) return null

  const p = hits / n
  const z2 = Z_95 * Z_95
  const denominator = 1 + z2 / n
  const center = (p + z2 / (2 * n)) / denominator
  const halfWidth = (Z_95 * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / denominator

  return { low: Math.max(0, center - halfWidth), high: Math.min(1, center + halfWidth) }
}

const round = (value: number): number => {
  return Math.round(value * 10_000) / 10_000
}

export const toRate = (hits: number, n: number): Rate => {
  const interval = wilsonInterval(hits, n)

  return {
    hits,
    n,
    rate: n === 0 ? null : round(hits / n),
    ci95: interval && { low: round(interval.low), high: round(interval.high) },
  }
}

/**
 * Hashes (full) of the in-range commits a later in-range commit reverts. The sha form is git's own
 * `revert` body; the subject form catches reverts whose body was rewritten or squashed away, pairing with
 * the most recent earlier commit carrying that exact subject.
 */
const findRevertedHashes = (commitsOldestFirst: ParsedCommit[]): Set<string> => {
  const reverted = new Set<string>()

  for (const [position, commit] of commitsOldestFirst.entries()) {
    if (!isRevertCommit(commit)) continue

    const earlier = commitsOldestFirst.slice(0, position)
    const sha = REVERT_SHA_PATTERN.exec(commit.body)?.[1]
    const subject = REVERT_SUBJECT_PATTERN.exec(commit.subject)?.[1]

    const target = sha
      ? earlier.find((candidate) => {
          return candidate.hash.startsWith(sha)
        })
      : earlier.findLast((candidate) => {
          return candidate.subject === subject
        })

    if (target) reverted.add(target.hash)
  }

  return reverted
}

const sharesFile = (a: ParsedCommit, b: ParsedCommit): boolean => {
  const relevant = new Set(
    a.files.filter((file) => {
      return !FOLLOW_UP_IGNORED_FILES.includes(file.split('/').at(-1) ?? file)
    }),
  )

  return b.files.some((file) => {
    return relevant.has(file)
  })
}

/**
 * A change "needed a follow-up fix" when a LATER fix commit ({@link isFixCommit}), landing at most 72h
 * after it, touches at least one of the same files. Who wrote the fix does not matter: an agent change
 * a human had to patch counts against the agent class, which is the point of the metric.
 */
const hasFollowUpFix = (change: ParsedCommit, changePosition: number, commitsOldestFirst: ParsedCommit[]): boolean => {
  return commitsOldestFirst.slice(changePosition + 1).some((candidate) => {
    return (
      candidate.committedAt - change.committedAt <= FOLLOW_UP_WINDOW_SECONDS &&
      isFixCommit(candidate) &&
      sharesFile(change, candidate)
    )
  })
}

// The revert rate is NOT right-censored like the follow-up rate: a change made yesterday has had
// less time to be reverted, so a range ending today slightly understates it.
export const computeClassStats = (
  commitsOldestFirst: ParsedCommit[],
  nowSeconds: number,
): Record<CommitClass | 'total', ClassStats> => {
  const reverted = findRevertedHashes(commitsOldestFirst)

  const buildFor = (include: (cls: CommitClass) => boolean): ClassStats => {
    const indexed = commitsOldestFirst
      .map((commit, position) => {
        return { commit, position }
      })
      .filter(({ commit }) => {
        return include(classifyCommit(commit))
      })

    // A revert is the remediation, not a change that can itself fail — keeping it in the denominator
    // would let a burst of reverts dilute the very rate it raises.
    const changes = indexed.filter(({ commit }) => {
      return !isRevertCommit(commit)
    })

    // Right-censoring: a change younger than the window has not had 72h to attract a fix yet, so it
    // would only ever count as "no follow-up" and bias the rate down.
    const matured = changes.filter(({ commit }) => {
      return nowSeconds - commit.committedAt >= FOLLOW_UP_WINDOW_SECONDS
    })

    const revertHits = changes.filter(({ commit }) => {
      return reverted.has(commit.hash)
    }).length

    const followUpHits = matured.filter(({ commit, position }) => {
      return hasFollowUpFix(commit, position, commitsOldestFirst)
    }).length

    return {
      commits: indexed.length,
      reverts: indexed.length - changes.length,
      changes: changes.length,
      revertRate: toRate(revertHits, changes.length),
      followUpFixRate: toRate(followUpHits, matured.length),
    }
  }

  return {
    agent: buildFor((cls) => {
      return cls === 'agent'
    }),
    human: buildFor((cls) => {
      return cls === 'human'
    }),
    total: buildFor(() => {
      return true
    }),
  }
}

export const compareRates = (agent: Rate, human: Rate): MetricComparison => {
  const small = [
    agent.n < MIN_COMPARISON_N ? `agent n=${agent.n}` : null,
    human.n < MIN_COMPARISON_N ? `human n=${human.n}` : null,
  ].filter(Boolean)

  if (small.length > 0 || agent.rate === null || human.rate === null || !agent.ci95 || !human.ci95) {
    return {
      suppressed: true,
      reason: `${small.join(', ')} < ${MIN_COMPARISON_N}`,
      difference: null,
      intervalsOverlap: null,
    }
  }

  return {
    suppressed: false,
    reason: null,
    difference: round(agent.rate - human.rate),
    intervalsOverlap: agent.ci95.low <= human.ci95.high && human.ci95.low <= agent.ci95.high,
  }
}

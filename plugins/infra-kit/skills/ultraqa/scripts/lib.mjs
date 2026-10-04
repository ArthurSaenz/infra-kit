// Pure helpers behind qa-state.mjs — no I/O here, so the tests drive them directly.
import { join } from 'node:path'

const RELEASE_PREFIX = 'release/'
const SEMVER_RE = /^v(\d+\.\d+\.\d+)$/
const KEBAB_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
const MAX_NAME_LENGTH = 50
const RESERVED_NAMES = new Set(['dev', 'main', 'next', 'hotfix', 'regular', 'release'])
const TICKET_KEY_RE = /\b[A-Z][A-Z0-9]+-\d+\b/g

/**
 * The release a branch belongs to, mirroring the CLI's `parseBranchName` + `formatJiraName`:
 * `release/v1.2.3` is Jira fix version `v1.2.3`, `release/<name>` is fix version `<name>`.
 */
export const releaseFromBranch = (branch) => {
  const stripped = String(branch ?? '')
    .trim()
    .replace(/^refs\/heads\//, '')

  if (!stripped.startsWith(RELEASE_PREFIX)) return null

  const rest = stripped.slice(RELEASE_PREFIX.length)
  const version = SEMVER_RE.exec(rest)

  if (version) return { branch: stripped, label: version[1], jiraName: `v${version[1]}` }

  // A non-semver `v…` (`release/vouchers`) is a name, as in the CLI's `validateName`.
  if (KEBAB_RE.test(rest) && rest.length <= MAX_NAME_LENGTH && !RESERVED_NAMES.has(rest)) {
    return { branch: stripped, label: rest, jiraName: rest }
  }

  return null
}

/** Outside the repo on purpose: a consumer's .gitignore is not ours to rely on, and the state must
 * outlive the release worktree it was taken in. */
export const stateDirFor = (home, repoName, releaseLabel) => {
  return join(home, '.infra-kit', 'qa', repoName, releaseLabel)
}

/** `git worktree list --porcelain` → the worktrees checked out on a release branch. */
export const releaseWorktrees = (porcelain) => {
  return String(porcelain ?? '')
    .split('\n\n')
    .map((block) => {
      const path = /^worktree (.+)$/m.exec(block)?.[1]
      const branch = /^branch (.+)$/m.exec(block)?.[1]

      return path && branch ? { path, release: releaseFromBranch(branch) } : null
    })
    .filter((entry) => entry?.release)
    .map((entry) => ({ path: entry.path, branch: entry.release.branch, label: entry.release.label }))
}

const BLOCK_NODES = new Set(['paragraph', 'heading', 'blockquote', 'codeBlock', 'rule', 'panel', 'tableRow'])

/** Atlassian Document Format → plain text. Lossy by design: the reader is an agent building test
 * ideas, so structure matters (lists, headings, links) and styling does not. */
export const adfToText = (node, depth = 0) => {
  if (node === null || node === undefined) return ''
  if (typeof node === 'string') return node
  if (Array.isArray(node)) return node.map((child) => adfToText(child, depth)).join('')

  const children = () => adfToText(node.content ?? [], depth)

  switch (node.type) {
    case 'text': {
      const link = node.marks?.find((mark) => mark.type === 'link')?.attrs?.href

      return link && link !== node.text ? `${node.text} (${link})` : (node.text ?? '')
    }
    case 'hardBreak':
      return '\n'
    case 'status':
      return node.attrs?.text ? `[${node.attrs.text}]` : ''
    case 'date':
      return node.attrs?.timestamp ? new Date(Number(node.attrs.timestamp)).toISOString().slice(0, 10) : ''
    case 'taskItem':
    case 'decisionItem': {
      const mark = node.type === 'taskItem' ? (node.attrs?.state === 'DONE' ? '[x]' : '[ ]') : '◆'

      return `${'  '.repeat(depth)}- ${mark} ${children().trim()}\n`
    }
    case 'mention':
      return node.attrs?.text ?? '@someone'
    case 'emoji':
      return node.attrs?.text ?? node.attrs?.shortName ?? ''
    case 'inlineCard':
    case 'blockCard':
    case 'embedCard':
      return node.attrs?.url ? `${node.attrs.url}\n` : ''
    case 'media':
    case 'mediaSingle':
    case 'mediaGroup':
      return '[attachment]\n'
    case 'bulletList':
    case 'orderedList':
      return (node.content ?? [])
        .map((item, index) => {
          const marker = node.type === 'orderedList' ? `${index + 1}.` : '-'
          const body = adfToText(item.content ?? [], depth + 1).trim()

          return `${'  '.repeat(depth)}${marker} ${body}\n`
        })
        .join('')
    case 'heading':
      return `${'#'.repeat(node.attrs?.level ?? 3)} ${children().trim()}\n`
    case 'codeBlock':
      return `\`\`\`\n${children()}\n\`\`\`\n`
    case 'tableCell':
    case 'tableHeader':
      return `${children().trim()} | `
    default:
      return BLOCK_NODES.has(node.type) ? `${children()}\n` : children()
  }
}

export const ticketKeysIn = (text) => {
  return [...new Set(String(text ?? '').match(TICKET_KEY_RE) ?? [])]
}

/**
 * Tickets vs the commits the branch carries. Both leftovers are QA signals: a ticket with no commit
 * is in the release on paper only, and a commit naming no release ticket is a change nobody asked
 * QA to look at.
 */
export const correlate = (ticketKeys, commits) => {
  const known = new Set(ticketKeys)
  const commitsByTicket = Object.fromEntries(ticketKeys.map((key) => [key, []]))
  const untrackedCommits = []

  for (const commit of commits) {
    const keys = ticketKeysIn(commit.subject).filter((key) => known.has(key))

    // A PR merge often carries the key only in its branch name, so merges count for their ticket;
    // a merge naming none is a `dev` sync, not an untracked change.
    if (keys.length === 0 && !commit.merge) untrackedCommits.push({ sha: commit.sha, subject: commit.subject })

    for (const key of keys) commitsByTicket[key].push(commit.sha)
  }

  return {
    commitsByTicket,
    withoutCommits: ticketKeys.filter((key) => commitsByTicket[key].length === 0),
    untrackedCommits,
  }
}

/** `git log --format=%h%x09%p%x09%s` output → `{ sha, subject, merge }[]`. */
export const parseCommits = (log) => {
  return String(log ?? '')
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [sha, parents = '', ...rest] = line.split('\t')

      return { sha, subject: rest.join('\t'), merge: parents.trim().split(/\s+/).length > 1 }
    })
}

const isPlainObject = (value) => {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** Objects merge key by key; arrays and scalars replace — a re-run's `runs` must not append to the
 * previous run's. */
export const mergeState = (base, patch) => {
  if (!isPlainObject(base) || !isPlainObject(patch)) return patch

  const merged = { ...base }

  for (const [key, value] of Object.entries(patch)) {
    merged[key] = isPlainObject(value) && isPlainObject(base[key]) ? mergeState(base[key], value) : value
  }

  return merged
}

export const PHASES = ['release', 'apps', 'env', 'tickets', 'scope', 'runs', 'report', 'artifact']

/** The phases whose result depends on the commit the pass ran against. */
const HEAD_BOUND_PHASES = ['scope', 'runs', 'report', 'artifact']

/**
 * Re-point a resumed state at a new HEAD (or base): everything measured against the old commit goes
 * back to pending, while the answers that do not move with it — language, mode, env, apps, the ticket
 * fetch — are kept. The page link is kept too, so the re-published report reaches the same URL.
 */
export const rebaseState = (state, { headSha, base }) => {
  return {
    ...state,
    headSha,
    base,
    phases: {
      ...state.phases,
      ...Object.fromEntries(HEAD_BOUND_PHASES.map((phase) => [phase, 'pending'])),
    },
    focusDomains: [],
    coverageGaps: [],
    runs: [],
    hollowGreen: [],
    manualChecklist: [],
    verdict: null,
  }
}

/** What `init` prints: enough to decide resume vs start over, not the whole run history. */
export const stateSummary = (state) => {
  return {
    release: state.release,
    lang: state.lang,
    base: state.base,
    headSha: state.headSha,
    mode: state.mode,
    env: state.env,
    phases: state.phases,
    tickets: state.tickets ? { count: state.tickets.count, fetchedAt: state.tickets.fetchedAt } : null,
    runs: state.runs.length,
    verdict: state.verdict,
    artifact: state.artifact,
  }
}

export const newState = ({ release, repo, worktree, headSha, base, lang, now }) => {
  return {
    schema: 1,
    release,
    repo,
    worktree,
    headSha,
    base,
    lang,
    startedAt: now,
    updatedAt: now,
    phases: Object.fromEntries(PHASES.map((phase) => [phase, phase === 'release' ? 'done' : 'pending'])),
    mode: null,
    env: null,
    servedEnv: null,
    tickets: null,
    apps: [],
    focusDomains: [],
    coverageGaps: [],
    runs: [],
    hollowGreen: [],
    manualChecklist: [],
    verdict: null,
    artifact: null,
  }
}

/** The Jira issue as the agent needs it — flat, text-only, comments in order. */
export const toTicket = (issue, comments, baseUrl) => {
  const fields = issue.fields ?? {}

  return {
    key: issue.key,
    url: `${baseUrl}/browse/${issue.key}`,
    type: fields.issuetype?.name ?? null,
    status: fields.status?.name ?? null,
    priority: fields.priority?.name ?? null,
    assignee: fields.assignee?.displayName ?? null,
    summary: fields.summary ?? '',
    labels: fields.labels ?? [],
    components: (fields.components ?? []).map((component) => component.name),
    parent: fields.parent ? { key: fields.parent.key, summary: fields.parent.fields?.summary ?? '' } : null,
    description: adfToText(fields.description).trim(),
    comments: comments.map((comment) => ({
      author: comment.author?.displayName ?? null,
      created: comment.created ?? null,
      text: adfToText(comment.body).trim(),
    })),
  }
}

export const ticketsMarkdown = (release, tickets) => {
  const sections = tickets.map((ticket) => {
    const meta = [ticket.type, ticket.status, ticket.priority, ticket.assignee && `@${ticket.assignee}`]
      .filter(Boolean)
      .join(' · ')
    const extra = [
      ticket.parent && `Parent: ${ticket.parent.key} — ${ticket.parent.summary}`,
      ticket.labels.length > 0 && `Labels: ${ticket.labels.join(', ')}`,
      ticket.components.length > 0 && `Components: ${ticket.components.join(', ')}`,
    ].filter(Boolean)
    const comments =
      ticket.comments.length === 0
        ? '_No comments._'
        : ticket.comments
            .map((c) => `- **${c.author ?? '?'}** (${c.created?.slice(0, 10) ?? '?'}): ${c.text}`)
            .join('\n')

    return [
      `## [${ticket.key}](${ticket.url}) — ${ticket.summary}`,
      meta,
      ...extra,
      '',
      '### Description',
      ticket.description || '_Empty._',
      '',
      '### Comments',
      comments,
    ].join('\n')
  })

  return [`# ${release.jiraName} — ${tickets.length} tickets`, '', ...sections].join('\n\n')
}

# Analytics Reference

> **Optional.** Analytics integration is only for client-facing projects. Skip for backend/API, internal tooling, or static sites.

## When to Add Analytics

Add an `analytics.ts` file to a feature when the project tracks user interactions (clicks, form submissions, feature usage, A/B testing). Never add analytics to backend code.

## Event Naming Conventions

**Pattern:** `[feature]_[component]_[action]_[target]` — always `snake_case`, past tense.

```typescript
// ✅ Good
'user_profile_viewed'
'task_list_filter_applied'
'search_result_clicked'

// ❌ Bad
'UserProfileViewed'       // wrong case
'click'                   // too generic
'viewing_profile'         // present tense
```

**Standard verbs:** viewed, clicked, submitted, saved, created, updated, deleted, uploaded, downloaded, shared, filtered, searched, opened, closed.

## Feature Analytics File

```
features/task-manager/
├── index.ts
├── types.ts
├── services.ts
└── analytics.ts          # Feature analytics
```

```typescript
// features/task-manager/analytics.ts
import { trackEvent } from '#root/lib/analytics'

interface TaskCreatedPayload {
  task_id: string
  task_type: string
  source: 'form' | 'quick_add' | 'import'
}

export function trackTaskCreated(payload: TaskCreatedPayload): void {
  trackEvent('task_created', payload)
}

export function trackTaskCompleted(taskId: string, taskType: string): void {
  trackEvent('task_completed', { task_id: taskId, task_type: taskType })
}
```

All tracking functions follow the same pattern: typed payload interface → exported function → `trackEvent(name, payload)`.

## Integration with Services

Call tracking functions from service atoms after successful operations:

```typescript
// features/task-manager/services.ts
import { trackTaskCreated } from './analytics'

export const createTaskFx = atom(
  null,
  async (get, set, args: CreateTaskFxArgs) => {
    try {
      const response = await httpClient.fetch<Task>('/api/tasks', {
        method: 'POST',
        body: args,
      })
      set($taskData, response.body)

      // Track after success — never on error
      trackTaskCreated({
        task_id: response.body.id,
        task_type: args.type,
        source: args.source,
      })
    } catch (error) {
      set($error, error)
    }
  }
)
```

## Testing Analytics

Mock `trackEvent` or the feature's analytics module, then assert calls:

```typescript
// features/task-manager/__tests__/analytics.test.ts
import { vi, describe, it, expect, beforeEach } from 'vitest'
import { trackEvent } from '#root/lib/analytics'
import { trackTaskCreated } from '../analytics'

vi.mock('#root/lib/analytics')

describe('Task Analytics', () => {
  beforeEach(() => { vi.clearAllMocks() })

  it('tracks task creation with correct payload', () => {
    trackTaskCreated({ task_id: '1', task_type: 'bug', source: 'form' })

    expect(trackEvent).toHaveBeenCalledWith('task_created', {
      task_id: '1',
      task_type: 'bug',
      source: 'form',
    })
  })
})
```

## Best Practices

- **snake_case event names** — strictly enforced, no exceptions
- **Type every payload** — dedicated interface per event
- **Track after success** — never fire events before the operation completes
- **No PII in payloads** — never include email, name, phone, or address
- **One analytics.ts per feature** — co-located with the feature it tracks
- **Don't over-track** — meaningful user actions only, not mouse moves or scroll pixels

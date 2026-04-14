# API Layer & Error Handling

Patterns for API integration using Fetch-based HTTP client, error handling, and Sentry integration.

## HTTP Client

```typescript
import { httpClient } from '#root/lib/http-client'
```

**Response structure:** `{ body: T, status: number, headers?: Record<string, string>, ok: boolean }`

Always access `response.body` for data — never use the response object directly.

## Basic Patterns

### GET
```typescript
const response = await httpClient.fetch<User>(`/api/users/${args.userId}`, { method: 'GET' })
set($userData, response.body)
```

### POST
```typescript
const response = await httpClient.fetch<User>('/api/users', {
  method: 'POST',
  body: { name: args.name, email: args.email },
})
set($userData, response.body)
```

### PATCH/PUT
```typescript
const response = await httpClient.fetch<User>(`/api/users/${args.userId}`, {
  method: 'PATCH',
  body: args.updates,
})
set($userData, response.body)
```

### DELETE
```typescript
await httpClient.fetch<void>(`/api/users/${args.userId}`, { method: 'DELETE' })
set($userData, null)
```

## Complete Effect Pattern

```typescript
interface GetUserFxArgs {
  userId: string
}

export const getUserFx = atom(
  null,
  async (get, set, args: GetUserFxArgs) => {
    set($isLoading, true)
    set($error, null)

    try {
      const response = await httpClient.fetch<User>(`/api/users/${args.userId}`, {
        method: 'GET',
      })

      Sentry.addBreadcrumb({
        category: 'getUserFx',
        message: 'Fetched user',
        data: { userId: args.userId, requestId: response.headers?.['x-amzn-requestid'] },
        level: 'info',
      })

      set($userData, response.body)
    } catch (error) {
      Sentry.captureException(error, { tags: { section: 'getUserFx' } })
      set($error, error as Error)
      throw error
    } finally {
      set($isLoading, false)
    }
  }
)
```

## Error Handling

### Two Error Types

1. **ServerError** (status 570) — Business logic errors from `@pkg/web-toolkit`
2. **Standard Error** — Infrastructure/network errors

```typescript
import { ServerError } from '@pkg/web-toolkit'

catch (error) {
  if (error instanceof ServerError) {
    // Business error: error.type, error.message, error.extraData, error.metaData
    switch (error.type) {
      case EManagedError.USER_NOT_FOUND:
        set($error, new Error('User not found'))
        break
      default:
        set($error, new Error(error.message))
    }
  } else {
    // Infrastructure error
    set($error, error as Error)
  }
  throw error
}
```

### ServerError Properties
- `error.type` — Error type string (use `EManagedError` enum)
- `error.message` — Human-readable message
- `error.extraData` — Additional data from server
- `error.metaData.req` — Request info (url, body)
- `error.metaData.res` — Response info (status, headers)

### Error State Patterns

**Basic:** `export const $error = atom<Error | null>(null)`

**Typed:**
```typescript
type CheckoutError =
  | { type: 'validation'; field: string; message: string }
  | { type: 'payment_failed'; code: string; message: string }
  | { type: 'network'; message: string }

export const $checkoutError = atom<CheckoutError | null>(null)
```

**Multiple operations:**
```typescript
export const $fetchError = atom<Error | null>(null)
export const $saveError = atom<Error | null>(null)
export const $hasError = atom((get) => !!(get($fetchError) || get($saveError)))
```

## Query Parameters

```typescript
import queryString from 'query-string'

const queryParams = `?${queryString.stringify(
  { category: args.category, tags: args.tags },
  { arrayFormat: 'bracket-separator', arrayFormatSeparator: '|' }
)}`
const response = await httpClient.fetch<Product[]>(`/api/products${queryParams}`, { method: 'GET' })
```

## Sentry Integration

```typescript
import * as Sentry from '@sentry/react'

// Breadcrumbs for debugging
Sentry.addBreadcrumb({
  category: 'getUserFx',
  message: 'Fetching user',
  data: { userId: args.userId },
  level: 'info',
})

// Error capture with context
Sentry.captureException(error, {
  tags: { section: 'getUserFx' },
  extra: { userId: args.userId },
})
```

## Caching (Rarely Used)

API caching is NOT standard. Only use for static config files with ETag support:

```typescript
import { idb } from '@pkg/web-toolkit'

const cachedData = await idb.get<{ etag: string; data: T }>(cacheKey)
const response = await httpClient.fetch<T>(url, {
  method: 'GET',
  headers: cachedData?.etag ? { 'If-None-Match': cachedData.etag } : undefined,
})

if (response.status === 304 && cachedData) return cachedData.data

if (response.headers?.etag) {
  await idb.set(cacheKey, { etag: response.headers.etag, data: response.body }, 604800) // 7 days
}
return response.body
```

## File Operations

### Upload
```typescript
const formData = new FormData()
formData.append('file', args.file)
const response = await httpClient.fetch<{ url: string }>('/api/upload', {
  method: 'POST',
  body: formData, // Content-Type set automatically
})
```

## Testing API Layers

```typescript
vi.mock('#root/lib/http-client', () => ({
  httpClient: { fetch: vi.fn() },
}))

vi.mocked(httpClient.fetch).mockResolvedValueOnce({
  body: mockUser, status: 200, headers: {}, ok: true,
})

const store = createStore()
await store.set(service.getUserFx, { userId: '1' })
expect(store.get(service.$userData)).toEqual(mockUser)
```

## Best Practices

- Always use object arguments with typed interfaces for write-only atoms
- Always access `response.body` (not the response directly)
- Handle both ServerError and standard Error
- Set loading state in `finally` block
- Add Sentry breadcrumbs for API calls
- Re-throw errors after setting error state
- Use `query-string` for array/complex URL parameters

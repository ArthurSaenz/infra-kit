export { AuthFormContainer } from './containers/auth-form-container.js'
export { AuthProvider } from './containers/auth-provider.js'
export { AuthVerifyContainer } from './containers/auth-verify-container.js'
export { RequireAuthContainer } from './containers/require-auth-container.js'
export { UserMenuContainer } from './containers/user-menu-container.js'
export { AuthHttpError, createAuthClient, isUnauthorized } from './services/auth-client.js'
export { useAuth, useAuthStore } from './services/auth-context.js'
export { createAuthStore, DEFAULT_REQUEST_ERROR_TEXT } from './services/auth-store.js'
export { safeRedirect } from './services/safe-redirect.js'
export type {
  AuthClient,
  AuthClientOptions,
  AuthFormContainerProps,
  AuthFormRenderProps,
  AuthPaths,
  AuthProviderProps,
  AuthState,
  AuthStatus,
  AuthStore,
  AuthStoreOptions,
  AuthVerifyContainerProps,
  AuthVerifyState,
  MagicLinkRequest,
  MagicLinkResult,
  RequireAuthContainerProps,
  SessionRenderProps,
  UserMenuContainerProps,
  VerifyMagicLinkResult,
} from './types.js'

/**
 * AgentForEach Auth System — Public API
 *
 * Modular authentication system inspired by OpenClaw.
 * Configure providers in config/agentforeach.json under the "auth" key.
 *
 * Usage:
 *   import { resolveAuthContext } from "../auth/index.js";
 *   const auth = await resolveAuthContext(request);
 *   if (!auth) return unauthorized(request);
 */

// Primary resolver (replaces legacy easy-auth.ts resolveAuthContext)
export {
  resolveAuthContext,
  resetProviderChain,
  getActiveProviders,
} from "./resolver.js";

// Types
export type {
  AuthContext,
  AuthProvider,
  AuthProviderId,
  AuthConfig,
  AuthProviderConfig,
  EasyAuthProviderConfig,
  ApiKeyProviderConfig,
  JwtProviderConfig,
  TrustedProxyProviderConfig,
  InsecureHeaderProviderConfig,
  ApiKeyIdentity,
  AuthGlobalSettings,
} from "./types.js";

// Factory (for custom provider registration)
export {
  createProvider,
  registerProviderFactory,
  listProviderTypes,
} from "./factory.js";

// Config loader
export { loadAuthConfig, resetAuthConfig } from "./config.js";

// Role checks
export { hasRole, isAdmin } from "./roles.js";

// Individual providers (for direct usage / testing)
export { createEasyAuthProvider } from "./providers/easy-auth.js";
export { createApiKeyProvider } from "./providers/api-key.js";
export { createJwtProvider } from "./providers/jwt.js";
export { createTrustedProxyProvider } from "./providers/trusted-proxy.js";
export { createInsecureHeaderProvider } from "./providers/insecure-header.js";

/**
 * ECP Server Auth Types
 *
 * Re-exports all auth types from the protocol layer.
 * Server consumers import from here to avoid reaching into protocol/ directly.
 */

export {
  type HandshakeClientInfo,
  type HandshakeParams,
  type AuthRequiredParams,
  type HandshakeResult,
  type AuthState,
  type AuthenticatedClientData,
  type AuthConfig,
  type AuthErrorCode,
  AuthErrorCodes,
} from '../../protocol/auth.ts';

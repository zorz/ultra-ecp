/**
 * ECP Authentication Module
 */

export * from './types.ts';
export {
  generateSessionId,
  buildAuthRequiredNotification,
  validateHandshake,
  buildNotAuthenticatedError,
  isHandshakeRequest,
  getHandshakeTimeout,
  getHeartbeatInterval,
  validateLegacyToken,
} from './handshake.ts';

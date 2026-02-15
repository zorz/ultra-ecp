/**
 * PKCE (Proof Key for Code Exchange) utilities
 *
 * Implements RFC 7636 for secure OAuth 2.0 authorization code flow.
 */

import { randomBytes, createHash } from 'crypto';

export interface PKCEChallenge {
  verifier: string;
  challenge: string;
  method: 'S256';
}

/**
 * Generate a cryptographically random code verifier.
 * Must be between 43-128 characters, using unreserved URI characters.
 */
function generateVerifier(length = 64): string {
  const bytes = randomBytes(length);
  // Base64url encode (RFC 4648 Section 5)
  return bytes
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=/g, '')
    .slice(0, length);
}

/**
 * Generate the code challenge from the verifier using SHA-256.
 */
function generateChallenge(verifier: string): string {
  const hash = createHash('sha256').update(verifier).digest();
  // Base64url encode
  return hash
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=/g, '');
}

/**
 * Generate a PKCE challenge pair.
 */
export function generatePKCE(): PKCEChallenge {
  const verifier = generateVerifier();
  const challenge = generateChallenge(verifier);
  return {
    verifier,
    challenge,
    method: 'S256',
  };
}

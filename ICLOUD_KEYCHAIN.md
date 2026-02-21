# iCloud Keychain Credential Sharing — Client Guide

This document describes how the Ultra Mac and iPad apps discover and authenticate with the ECP server using iCloud Keychain for zero-config cross-device credential sharing.

## Overview

The system has three layers:

1. **Server** writes `~/.ultra/server.json` on startup with connection info (host, port, token, cert fingerprint).
2. **Mac app** reads `server.json` and pushes a connection profile to iCloud Keychain (`kSecAttrSynchronizable`).
3. **iPad app** reads connection profiles from iCloud Keychain automatically — no manual setup required.

The auth token persists across server restarts at `~/.ultra/auth-token`, so stored credentials remain valid.

## Server-Side Files

### `~/.ultra/auth-token`

A 64-character hex string (32 random bytes). Created on first server start, reused across restarts. The `--token` CLI flag overrides this but does **not** update the file.

- **Permissions:** `0600` (owner read/write only)

### `~/.ultra/server.json`

Written after the transport starts. Removed on graceful shutdown.

```json
{
  "host": "127.0.0.1",
  "port": 7070,
  "scheme": "wss",
  "token": "a1b2c3d4...64chars",
  "certFingerprint": "sha256:abc123def456...",
  "serverVersion": "0.1.0",
  "startedAt": 1740000000000,
  "pid": 12345
}
```

- **Permissions:** `0600` (owner read/write only — contains the auth token)
- `certFingerprint` is `null` when TLS is disabled (`--no-tls`)
- `startedAt` is Unix epoch milliseconds
- `pid` can be used to verify the server is still running (`kill -0 <pid>`)

### Handshake Response

The `auth/handshake` response now includes `certFingerprint`:

```json
{
  "jsonrpc": "2.0",
  "id": "1",
  "result": {
    "clientId": "uuid",
    "sessionId": "uuid",
    "serverVersion": "0.1.0",
    "workspaceRoot": "/path/to/project",
    "certFingerprint": "sha256:abc123def456..."
  }
}
```

`certFingerprint` is omitted when TLS is not enabled.

## iCloud Keychain Storage (Swift)

### Data Model

```swift
import Foundation

struct ECPConnectionProfile: Codable {
    let host: String
    let port: Int
    let scheme: String        // "ws" or "wss"
    let token: String
    let certFingerprint: String?
    let serverVersion: String
    let machineName: String   // hostname of the machine running ECP
}
```

### Store a Profile

```swift
import Security

func storeConnectionProfile(_ profile: ECPConnectionProfile) throws {
    let data = try JSONEncoder().encode(profile)

    let query: [String: Any] = [
        kSecClass as String: kSecClassGenericPassword,
        kSecAttrService as String: "com.ultra.ecp.connection",
        kSecAttrAccount as String: profile.machineName,
        kSecValueData as String: data,
        kSecAttrSynchronizable as String: true,  // iCloud sync
        kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlock,
    ]

    // Delete existing entry for this machine, then add
    SecItemDelete(query as CFDictionary)
    let status = SecItemAdd(query as CFDictionary, nil)
    guard status == errSecSuccess else {
        throw KeychainError.storeFailed(status)
    }
}
```

### Read a Profile

```swift
func readConnectionProfile(machineName: String) throws -> ECPConnectionProfile? {
    let query: [String: Any] = [
        kSecClass as String: kSecClassGenericPassword,
        kSecAttrService as String: "com.ultra.ecp.connection",
        kSecAttrAccount as String: machineName,
        kSecAttrSynchronizable as String: true,
        kSecReturnData as String: true,
        kSecMatchLimit as String: kSecMatchLimitOne,
    ]

    var result: AnyObject?
    let status = SecItemCopyMatching(query as CFDictionary, &result)
    guard status == errSecSuccess, let data = result as? Data else { return nil }
    return try JSONDecoder().decode(ECPConnectionProfile.self, from: data)
}
```

### List All Profiles (Multi-Machine)

```swift
func listConnectionProfiles() throws -> [ECPConnectionProfile] {
    let query: [String: Any] = [
        kSecClass as String: kSecClassGenericPassword,
        kSecAttrService as String: "com.ultra.ecp.connection",
        kSecAttrSynchronizable as String: true,
        kSecReturnData as String: true,
        kSecMatchLimit as String: kSecMatchLimitAll,
    ]

    var result: AnyObject?
    let status = SecItemCopyMatching(query as CFDictionary, &result)
    guard status == errSecSuccess, let items = result as? [Data] else { return [] }
    return items.compactMap { try? JSONDecoder().decode(ECPConnectionProfile.self, from: $0) }
}
```

## TLS Certificate Pinning

The `certFingerprint` value is the SHA-256 hash of the DER-encoded certificate, formatted as `sha256:<hex>`. Use it to verify the self-signed certificate during the TLS handshake:

```swift
import CryptoKit

// URLSessionDelegate for certificate pinning
func urlSession(
    _ session: URLSession,
    didReceive challenge: URLAuthenticationChallenge,
    completionHandler: @escaping (URLSession.AuthChallengeDisposition, URLCredential?) -> Void
) {
    guard let trust = challenge.protectionSpace.serverTrust,
          let cert = SecTrustGetCertificateAtIndex(trust, 0) else {
        completionHandler(.cancelAuthenticationChallenge, nil)
        return
    }

    let certData = SecCertificateCopyData(cert) as Data
    let hash = SHA256.hash(data: certData)
    let fingerprint = "sha256:" + hash.map { String(format: "%02x", $0) }.joined()

    if fingerprint == expectedFingerprint {
        // Certificate matches — trust it
        completionHandler(.useCredential, URLCredential(trust: trust))
    } else {
        // Fingerprint mismatch — reject
        completionHandler(.cancelAuthenticationChallenge, nil)
    }
}
```

For `NWConnection` (Network.framework) WebSocket connections, use `sec_protocol_options_set_verify_block` to perform the same check.

## Connection Flow

### Mac App (Server Host)

1. Launch ECP server (or detect it's already running via `server.json` + PID check)
2. Read `~/.ultra/server.json`
3. Build `ECPConnectionProfile` with the local machine's hostname
4. Store profile in iCloud Keychain via `storeConnectionProfile()`
5. Connect to the server using the profile

### iPad App (Remote Client)

1. Call `listConnectionProfiles()` to get all stored server profiles
2. Present a server picker if multiple machines are available
3. Connect using stored `host:port` with the `scheme` (ws/wss)
4. Authenticate with `auth/handshake` using the stored `token`
5. Verify TLS certificate against stored `certFingerprint`
6. On token mismatch: display "Server credentials changed" — Mac app will update Keychain on next launch

### Stale Profile Detection

Before connecting, check if the server is reachable. If not:
- The profile's `startedAt` and `pid` fields can hint at staleness
- Show the profile as "offline" in the server picker
- Do **not** automatically delete stale profiles (the server may just be temporarily down)

## Keychain Service Identifier

All profiles use:
- **Service:** `com.ultra.ecp.connection`
- **Account:** Machine hostname (e.g., `Keiths-MacBook-Pro.local`)

This means each machine gets one profile entry. If a user has multiple Macs running ECP, each gets its own entry keyed by hostname.

## Phase 2: Passkey/WebAuthn (Future)

Phase 1 (this implementation) uses a shared-secret token. A future Phase 2 will add optional passkey/WebAuthn support via `webauthn-rs`:

- Biometric authentication (Touch ID / Face ID) instead of shared secrets
- Per-device credentials (no shared token to compromise)
- The `auth/handshake` protocol will be extended with a `"method": "webauthn"` option alongside the existing `"token"` method
- Phase 1 token auth will remain as a fallback

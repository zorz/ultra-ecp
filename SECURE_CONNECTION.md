# Secure Connection (TLS)

The ECP server uses TLS by default. On first launch it auto-generates a self-signed certificate at `~/.ultra/tls/` — no configuration needed.

## Server Startup

```bash
# Default — TLS enabled, auto-generated self-signed cert
ultra-ecp --token <TOKEN>

# Disable TLS (development/debugging only)
ultra-ecp --no-tls --token <TOKEN>

# Custom certificate
ultra-ecp --tls-cert /path/to/cert.pem --tls-key /path/to/key.pem --token <TOKEN>

# LAN access (e.g. iPad client)
ultra-ecp --hostname 0.0.0.0 --token <TOKEN>
```

## Connecting from Clients

The endpoint is `wss://` when TLS is enabled, `ws://` when disabled. The banner printed at startup shows the exact URL.

### Self-Signed Certificate Handling

Since the auto-generated cert is self-signed, clients need to either trust it or skip verification.

**JavaScript / Node.js (ws, undici, fetch):**
```js
// Option 1: Trust the specific CA cert
import { readFileSync } from "fs";
import { WebSocket } from "ws";

const ws = new WebSocket("wss://127.0.0.1:7070/ws", {
  ca: readFileSync(`${process.env.HOME}/.ultra/tls/cert.pem`),
});
```

```js
// Option 2: Skip verification (development only)
process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
const ws = new WebSocket("wss://127.0.0.1:7070/ws");
```

**Swift (URLSessionWebSocketTask):**
```swift
// Trust the server's self-signed cert via URLSessionDelegate
class TrustDelegate: NSObject, URLSessionDelegate {
    func urlSession(_ session: URLSession,
                    didReceive challenge: URLAuthenticationChallenge,
                    completionHandler: @escaping (URLSession.AuthChallengeDisposition, URLCredential?) -> Void) {
        if let trust = challenge.protectionSpace.serverTrust {
            completionHandler(.useCredential, URLCredential(trust: trust))
        }
    }
}

let session = URLSession(configuration: .default, delegate: TrustDelegate(), delegateQueue: nil)
let task = session.webSocketTask(with: URL(string: "wss://127.0.0.1:7070/ws")!)
task.resume()
```

**curl (for testing):**
```bash
# Trust the auto-generated cert
curl -k --cacert ~/.ultra/tls/cert.pem https://127.0.0.1:7070/health

# Or skip verification
curl -k https://127.0.0.1:7070/health
```

**websocat (for testing):**
```bash
websocat -k wss://127.0.0.1:7070/ws
```

## Certificate Details

| Item | Value |
|------|-------|
| Location | `~/.ultra/tls/cert.pem` and `key.pem` |
| Type | Self-signed, generated via `rcgen` |
| SANs | `localhost`, `127.0.0.1`, `::1`, machine hostname |
| Reuse | Certs are generated once and reused on subsequent launches |

To force regeneration, delete the files:
```bash
rm ~/.ultra/tls/cert.pem ~/.ultra/tls/key.pem
```

## LAN Access (e.g. iPad)

When binding to `0.0.0.0`, any device on the local network can connect. The auto-generated cert includes the machine's hostname as a SAN, so clients connecting via `<hostname>.local` will match.

```bash
ultra-ecp --hostname 0.0.0.0 --token <TOKEN>
# Connect from iPad: wss://<mac-hostname>.local:7070/ws
```

For production LAN use, consider using a custom cert that includes all the IP addresses and hostnames you'll connect from.

# Remote Connection (SSH)

Ultra clients on iPad/iPhone can connect to a Mac running the ECP server over SSH. The binary is bundled inside the Mac app and can be launched directly from the command line.

## Binary Location

When bundled with the Mac app:
```
/Applications/Ultra.app/Contents/MacOS/ultra-ecp
```

The app should create a symlink on first launch for easier access:
```bash
ln -sf /Applications/Ultra.app/Contents/MacOS/ultra-ecp /usr/local/bin/ultra-ecp
```

## Connection Flow

The remote Ultra client SSHs into the Mac and launches the server:

```bash
ultra-ecp \
  --hostname 0.0.0.0 \
  --port 0 \
  --workspace ~/Development/myproject \
  --token <client-generated-token> \
  --log-file
```

- `--hostname 0.0.0.0` — bind to all interfaces (required for LAN/SSH access)
- `--port 0` — let the OS assign a free port (avoids conflicts if the Mac app is already running its own instance)
- `--token <token>` — the connecting client generates and passes the token, so it knows the secret without any out-of-band exchange
- `--log-file` — writes logs to `~/.ultra/logs/ecp.log` for debugging via `tail -f`

## Reading the Assigned Port

With `--port 0`, the server prints the actual port in the startup banner:

```
  WebSocket endpoint:
    wss://0.0.0.0:54321/ws
```

The client should parse stdout for the `wss://` or `ws://` URL to extract the port. The banner is printed after all services are initialized, so the port line means the server is ready to accept connections.

## TLS

TLS is on by default with auto-generated self-signed certs at `~/.ultra/tls/`. The cert includes SANs for `localhost`, `127.0.0.1`, `::1`, and the machine's hostname — so connections via `<hostname>.local` will match.

The remote client should either trust the self-signed cert or skip verification for the SSH-tunneled connection (the SSH tunnel already provides encryption).

## Port Conflict with Mac App

If the Mac app is already running its own ECP server (e.g., on port 7070), the SSH-launched instance uses a different port via `--port 0`. Each instance has its own workspace scope — they don't interfere with each other.

## Future: iCloud Keychain Token Sync

The auth token and connection profile (hostname, port, cert fingerprint) can be synced across Apple devices via iCloud Keychain. This enables one-tap connection from iPad/iPhone without manual SSH setup.

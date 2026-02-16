#!/usr/bin/env bun
/**
 * Ultra ECP Standalone Server
 *
 * Runs the Editor Command Protocol server as a standalone process.
 * Clients connect via WebSocket with token-based auth handshake.
 *
 * Usage:
 *   bun run src/main.ts                          # Start on default port 7070, cwd as workspace
 *   bun run src/main.ts --port 8080              # Custom port
 *   bun run src/main.ts --workspace /path/to/dir # Custom workspace
 *   bun run src/main.ts --token mysecret         # Custom auth token
 */

import { resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import { ECPServer } from './server/ecp-server.ts';
import { ECPWebSocketServer } from './server/websocket-server.ts';

// ─────────────────────────────────────────────────────────────────────────────
// CLI argument parsing
// ─────────────────────────────────────────────────────────────────────────────

interface CLIOptions {
  port: number;
  workspaceRoot: string;
  authToken?: string;
}

function parseArgs(args: string[]): CLIOptions {
  const portIndex = args.indexOf('--port');
  const tokenIndex = args.indexOf('--token');
  const workspaceIndex = args.indexOf('--workspace');

  let port = 7070;
  if (portIndex !== -1) {
    const portArg = args[portIndex + 1];
    if (portArg) {
      const parsed = parseInt(portArg, 10);
      if (!isNaN(parsed) && parsed >= 0 && parsed < 65536) {
        port = parsed;
      } else {
        console.error(`Invalid port: ${portArg}`);
        process.exit(1);
      }
    }
  }

  let authToken: string | undefined;
  if (tokenIndex !== -1) {
    const tokenArg = args[tokenIndex + 1];
    if (tokenArg) {
      authToken = tokenArg;
    }
  }

  let workspaceRoot: string;
  if (workspaceIndex !== -1) {
    const wsArg = args[workspaceIndex + 1];
    if (wsArg) {
      workspaceRoot = resolve(wsArg);
    } else {
      console.error('--workspace requires a path argument');
      process.exit(1);
    }
  } else {
    workspaceRoot = process.cwd();
  }

  return { port, workspaceRoot, authToken };
}

// ─────────────────────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const hostname = '127.0.0.1';

  console.log(`\n╔══════════════════════════════════════════════════════════════╗`);
  console.log(`║                     Ultra ECP Server                        ║`);
  console.log(`╚══════════════════════════════════════════════════════════════╝\n`);

  console.log(`  Workspace:  ${options.workspaceRoot}`);
  console.log(`  Port:       ${options.port}`);
  console.log(`  Binding:    ${hostname} (localhost only)\n`);

  // Create and initialize ECP server
  const ecpServer = new ECPServer({ workspaceRoot: options.workspaceRoot });
  await ecpServer.initialize();

  // Generate or use provided auth token
  const authToken = options.authToken ?? randomBytes(32).toString('hex');

  // Create WebSocket server
  const wsServer = new ECPWebSocketServer(ecpServer, {
    port: options.port,
    hostname,
    enableCors: false,
    workspaceRoot: options.workspaceRoot,
    authToken,
    verboseLogging: true,
    maxConnections: 4,
  });

  await wsServer.start();

  const actualPort = wsServer.getPort();
  const wsUrl = `ws://${hostname}:${actualPort}/ws`;

  console.log(`────────────────────────────────────────────────────────────────`);
  console.log(`\n  Server running!\n`);
  console.log(`  WebSocket endpoint:`);
  console.log(`    ${wsUrl}\n`);
  console.log(`  Auth token:`);
  console.log(`    ${authToken.substring(0, 8)}...${authToken.substring(authToken.length - 8)}\n`);
  console.log(`────────────────────────────────────────────────────────────────`);
  console.log(`\n  Press Ctrl+C to stop.\n`);

  // Graceful shutdown
  const shutdown = async () => {
    console.log('\n  Shutting down...');
    await wsServer.stop();
    await ecpServer.shutdown();
    console.log('  Server stopped.\n');
  };

  let shuttingDown = false;
  const handleSignal = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    await shutdown();
    process.exit(0);
  };

  process.on('SIGINT', handleSignal);
  process.on('SIGTERM', handleSignal);
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});

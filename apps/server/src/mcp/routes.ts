import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { registerTools, type ApiCall } from './tools.js';

// The MCP endpoint: POST /api/mcp speaks Streamable HTTP, stateless — every
// request gets a fresh McpServer + transport, so there is no session table
// and nothing to leak. Clients (Claude Code, Claude Desktop, Cursor …) point
// at http://host/api/mcp with `Authorization: Bearer $EAB_API_TOKEN`; the
// login gate in app.ts admits that header (auth.ts), the same way it admits
// the browser's cookie.
//
// Tools reach the app through app.inject(): an in-process request that runs
// the same hooks and route handlers an HTTP request would, so a tool call is
// exactly as authorised and as validated as the web UI's equivalent click.

export const MCP_PATH = '/api/mcp';
const SERVER_NAME = 'energie-agent-browser';
const SERVER_VERSION = '1.0.0';

/**
 * An ApiCall bound to one incoming MCP request: it forwards that request's
 * credentials (bearer or cookie) so the injected call passes the login gate,
 * and its project scope unless a tool names one.
 */
export function apiCallFor(app: FastifyInstance, req: FastifyRequest): ApiCall {
  const auth = req.headers.authorization;
  const cookie = req.headers.cookie;
  const scopeHeader = req.headers['x-project-id'];
  const defaultScope = Array.isArray(scopeHeader) ? scopeHeader[0] : scopeHeader;

  return async (method, url, opts = {}) => {
    const headers: Record<string, string> = {};
    if (typeof auth === 'string') headers.authorization = auth;
    if (typeof cookie === 'string') headers.cookie = cookie;
    if (opts.projectId != null) headers['x-project-id'] = String(opts.projectId);
    else if (defaultScope) headers['x-project-id'] = defaultScope;

    const res = await app.inject({
      method,
      url,
      headers,
      ...(opts.body !== undefined ? { payload: opts.body as Record<string, unknown> } : {}),
    });
    const contentType = res.headers['content-type'];
    const isJson = typeof contentType === 'string' && contentType.includes('application/json');
    let body: unknown = res.body;
    if (isJson) {
      try {
        body = res.json();
      } catch {
        /* leave the text */
      }
    }
    return { status: res.statusCode, body, raw: res.rawPayload };
  };
}

export async function mcpRoutes(app: FastifyInstance) {
  app.post(MCP_PATH, async (req, reply) => {
    const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });
    registerTools(server, apiCallFor(app, req));

    // Stateless: no session id, plain JSON responses (no SSE stream to keep
    // open), torn down when the response closes.
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    reply.raw.on('close', () => {
      void transport.close();
      void server.close();
    });

    // The SDK writes the response itself, so take the raw socket back from
    // Fastify; the body is already parsed by Fastify's JSON parser.
    reply.hijack();
    await server.connect(transport);
    await transport.handleRequest(req.raw, reply.raw, req.body);
  });

  // Stateless servers have no stream to resume and no session to end; say so
  // in protocol terms instead of letting the SPA fallback answer with HTML.
  const methodNotAllowed = async (_req: FastifyRequest, reply: FastifyReply) =>
    reply.code(405).send({
      jsonrpc: '2.0',
      error: { code: -32000, message: 'Method not allowed: this MCP endpoint is stateless; use POST.' },
      id: null,
    });
  app.get(MCP_PATH, methodNotAllowed);
  app.delete(MCP_PATH, methodNotAllowed);
}

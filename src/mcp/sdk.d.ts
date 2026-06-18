// Minimal ambient types for the slice of @modelcontextprotocol/sdk we use.
//
// The project compiles as CommonJS with classic ("node") module resolution,
// which does not read a package's `exports` map. The SDK exposes its entry
// points only via that map (./dist/cjs/** for the `require` condition), so a
// normal subpath import does not type-resolve. Rather than switch the whole
// tree to nodenext + explicit `.js` extensions, we declare the handful of SDK
// symbols we touch here. At runtime the static imports emit `require(...)`,
// which Node resolves through the package's `require` export condition to the
// shipped CommonJS build. See docs/12-mcp.md §"module compatibility".

declare module '@modelcontextprotocol/sdk/server/mcp.js' {
  export interface McpTextResult {
    content: Array<{ type: 'text'; text: string }>;
    isError?: boolean;
  }
  export interface ToolConfig {
    title?: string;
    description?: string;
    // A Zod raw shape ({ field: z.string(), ... }); the SDK derives the JSON
    // Schema and validates calls against it. Typed loosely to avoid pinning the
    // SDK's internal Zod-compat generics through this shim.
    inputSchema?: Record<string, unknown>;
    annotations?: Record<string, unknown>;
  }
  export class McpServer {
    constructor(info: { name: string; version: string }, options?: unknown);
    registerTool(
      name: string,
      config: ToolConfig,
      cb: (args: any) => Promise<McpTextResult> | McpTextResult,
    ): unknown;
    connect(transport: unknown): Promise<void>;
    close(): Promise<void>;
  }
}

declare module '@modelcontextprotocol/sdk/server/stdio.js' {
  export class StdioServerTransport {
    constructor();
  }
}

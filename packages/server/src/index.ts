// HTTP and MCP adapters for saveslot (docs/zh-CN/spec/02-architecture.md §11).

export * from "./api.ts";
export * from "./local.ts";
export { createMcpAdapter, handleMcp, type McpAdapter } from "./mcp/handler.ts";
export { TOOLS, type Tool, type ToolName } from "./mcp/tools.ts";
export * from "./status.ts";

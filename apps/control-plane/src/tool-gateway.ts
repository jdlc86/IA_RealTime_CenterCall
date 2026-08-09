export type ToolAccess = "READ" | "WRITE";

export type ToolContext = {
  tenantId: string;
  callId?: string;
};

export type ToolRequest = {
  name: string;
  arguments: unknown;
  context: ToolContext;
};

export type ToolSuccess<T = unknown> = {
  ok: true;
  tool: string;
  tenantId: string;
  access: ToolAccess;
  result: T;
};

export type ToolFailure = {
  ok: false;
  tool: string;
  tenantId: string;
  error: "TOOL_NOT_FOUND" | "TOOL_NOT_ALLOWED" | "INVALID_ARGUMENTS" | "EXECUTION_FAILED";
  message: string;
};

export type ToolResult<T = unknown> = ToolSuccess<T> | ToolFailure;

export type ToolDefinition<TArgs = unknown, TResult = unknown> = {
  name: string;
  access: ToolAccess;
  description: string;
  validate: (value: unknown) => TArgs;
  execute: (args: TArgs, context: ToolContext) => Promise<TResult>;
};

export type TenantToolPolicy = {
  tenantId: string;
  allowedTools: string[];
};

export class ToolGateway {
  private readonly tools = new Map<string, ToolDefinition<unknown, unknown>>();
  private readonly allowlists = new Map<string, Set<string>>();

  constructor(definitions: ToolDefinition<unknown, unknown>[], policies: TenantToolPolicy[]) {
    for (const definition of definitions) {
      if (!definition.name.trim()) throw new Error("Tool definition name is required");
      if (this.tools.has(definition.name)) throw new Error(`Duplicate tool definition: ${definition.name}`);
      this.tools.set(definition.name, definition);
    }

    for (const policy of policies) {
      if (!policy.tenantId.trim()) throw new Error("Tenant tool policy tenantId is required");
      if (this.allowlists.has(policy.tenantId)) throw new Error(`Duplicate tenant tool policy: ${policy.tenantId}`);
      this.allowlists.set(policy.tenantId, new Set(policy.allowedTools));
    }
  }

  async execute(request: ToolRequest): Promise<ToolResult> {
    const tenantId = request.context.tenantId?.trim();
    const toolName = request.name?.trim();

    if (!tenantId) {
      return {
        ok: false,
        tool: toolName || "unknown",
        tenantId: "unknown",
        error: "TOOL_NOT_ALLOWED",
        message: "tenant_id is required for every tool operation",
      };
    }

    const definition = this.tools.get(toolName);
    if (!definition) {
      return {
        ok: false,
        tool: toolName || "unknown",
        tenantId,
        error: "TOOL_NOT_FOUND",
        message: `Unknown tool: ${toolName || "<empty>"}`,
      };
    }

    const allowlist = this.allowlists.get(tenantId);
    if (!allowlist?.has(toolName)) {
      return {
        ok: false,
        tool: toolName,
        tenantId,
        error: "TOOL_NOT_ALLOWED",
        message: `Tool ${toolName} is not allowed for tenant ${tenantId}`,
      };
    }

    let args: unknown;
    try {
      args = definition.validate(request.arguments);
    } catch (error) {
      return {
        ok: false,
        tool: toolName,
        tenantId,
        error: "INVALID_ARGUMENTS",
        message: error instanceof Error ? error.message : String(error),
      };
    }

    try {
      const result = await definition.execute(args, request.context);
      return {
        ok: true,
        tool: toolName,
        tenantId,
        access: definition.access,
        result,
      };
    } catch (error) {
      return {
        ok: false,
        tool: toolName,
        tenantId,
        error: "EXECUTION_FAILED",
        message: error instanceof Error ? error.message : String(error),
      };
    }
  }
}

export function requireObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Tool arguments must be a JSON object");
  }
  return value as Record<string, unknown>;
}

export const PUBLIC_RESTAURANT_TOOLS = [
  "restaurant_reservation_create",
  "restaurant_reservation_query",
  "restaurant_reservation_modify",
  "restaurant_reservation_cancel",
  "restaurant_business_info",
  "restaurant_marketing_preferences",
  "restaurant_human_assistance",
  "restaurant_input_ignored",
  "restaurant_end_call",
  "restaurant_out_of_scope",
] as const;

export type PublicRestaurantTool = typeof PUBLIC_RESTAURANT_TOOLS[number];

export type PublicToolAuthorizationDecision = {
  allowed: boolean;
  tool: PublicRestaurantTool;
  requiredCapabilities: string[];
  matchedCapability: string | null;
  reason: "ALLOWED" | "TOOL_NOT_ALLOWED" | "BUILTIN_RUNTIME_TOOL";
};

const RESERVATION_CAPABILITIES = ["manage_reservation", "restaurant_reservation"];
const MARKETING_CAPABILITIES = ["restaurant_marketing_preferences", "marketing_consent", "manage_marketing_consent"];

const TOPIC_CAPABILITIES: Record<string, string[]> = {
  MENU: ["get_menu"],
  HOURS: ["get_business_hours"],
  SERVICES: ["get_services"],
  LOCATION: ["get_business_information"],
  GENERAL_INFO: ["get_business_information"],
};

export function isPublicRestaurantTool(value: unknown): value is PublicRestaurantTool {
  return typeof value === "string" && (PUBLIC_RESTAURANT_TOOLS as readonly string[]).includes(value);
}

function unique(values: string[]): string[] {
  return [...new Set(values.filter((value) => value.trim().length > 0))];
}

function anyAllowed(allowed: Set<string>, candidates: string[]): string | null {
  for (const candidate of candidates) if (allowed.has(candidate)) return candidate;
  return null;
}

export function authorizePublicRestaurantTool(
  tool: PublicRestaurantTool,
  args: Record<string, unknown>,
  configuredAllowedTools: readonly string[],
): PublicToolAuthorizationDecision {
  if (
    tool === "restaurant_end_call"
    || tool === "restaurant_out_of_scope"
    || tool === "restaurant_human_assistance"
    || tool === "restaurant_input_ignored"
  ) {
    return { allowed: true, tool, requiredCapabilities: [], matchedCapability: null, reason: "BUILTIN_RUNTIME_TOOL" };
  }

  const allowed = new Set(configuredAllowedTools.map((value) => value.trim()).filter(Boolean));
  if (allowed.has(tool)) {
    return { allowed: true, tool, requiredCapabilities: [tool], matchedCapability: tool, reason: "ALLOWED" };
  }

  if (tool.startsWith("restaurant_reservation_")) {
    const matched = anyAllowed(allowed, RESERVATION_CAPABILITIES);
    return { allowed: matched !== null, tool, requiredCapabilities: RESERVATION_CAPABILITIES, matchedCapability: matched, reason: matched ? "ALLOWED" : "TOOL_NOT_ALLOWED" };
  }

  if (tool === "restaurant_marketing_preferences") {
    const matched = anyAllowed(allowed, MARKETING_CAPABILITIES);
    return { allowed: matched !== null, tool, requiredCapabilities: MARKETING_CAPABILITIES, matchedCapability: matched, reason: matched ? "ALLOWED" : "TOOL_NOT_ALLOWED" };
  }

  if (tool === "restaurant_business_info") {
    const topics = Array.isArray(args.topics) ? args.topics.filter((value): value is string => typeof value === "string") : [];
    const required = unique(topics.flatMap((topic) => TOPIC_CAPABILITIES[topic] ?? ["get_business_information"]));
    const effectiveRequired = required.length ? required : ["get_business_information"];
    const missing = effectiveRequired.filter((capability) => !allowed.has(capability));
    return { allowed: missing.length === 0, tool, requiredCapabilities: effectiveRequired, matchedCapability: missing.length === 0 ? effectiveRequired.join(",") : null, reason: missing.length === 0 ? "ALLOWED" : "TOOL_NOT_ALLOWED" };
  }

  return { allowed: false, tool, requiredCapabilities: [tool], matchedCapability: null, reason: "TOOL_NOT_ALLOWED" };
}

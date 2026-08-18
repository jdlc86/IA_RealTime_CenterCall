import type { RealtimeProviderCommandPort } from "./realtime-provider-command-port";
import type { RealtimeProviderEvent } from "./realtime-provider-event";
import { realtimeCommandPortFor as openAIRealtimeCommandPortFor } from "./openai-realtime-command-adapter";
import { adaptOpenAIRealtimeEvent } from "./openai-realtime-event-adapter";

export type RealtimeProviderName = "OPENAI";

/**
 * Provider selection boundary for the current production runtime.
 *
 * IMPORTANT: this refactor deliberately keeps OpenAI as the only active
 * provider. Tenant/KV provider selection and Gemini are not enabled here.
 * Consumers depend on this neutral module so adding another provider later
 * does not require business/lifecycle layers to import a provider adapter.
 */
export const ACTIVE_REALTIME_PROVIDER: RealtimeProviderName = "OPENAI";

export type RealtimeProviderHost = object & {
  send(event: Record<string, unknown>): void;
};

export function realtimeCommandPortFor(host: RealtimeProviderHost): RealtimeProviderCommandPort {
  return openAIRealtimeCommandPortFor(host);
}

export function adaptRealtimeProviderEvents(data: unknown): RealtimeProviderEvent[] {
  return adaptOpenAIRealtimeEvent(data);
}

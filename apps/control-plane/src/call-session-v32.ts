import { CallSession as CallSessionV31 } from "./call-session-v31";
import { installRealtimeToolResultTransform } from "./realtime-provider-runtime.js";
import { localizeReservationSearchToolResult } from "./reservation-search-output-localization.js";

const BaseConstructor = CallSessionV31 as unknown as new (...args: any[]) => any;

/**
 * v32 removes UTC ambiguity from reservation suggestions.
 *
 * Supabase is authoritative for business-hours filtering. This layer installs a
 * provider-neutral tool-result transform so Lucia receives an explicit
 * Europe/Madrid representation before any provider adapter serializes the result.
 */
export class CallSession extends BaseConstructor {
  private outputLocalizerInstalledV32 = false;

  async fetch(request: Request): Promise<Response> {
    const response = await super.fetch(request);
    const isStart = request.method === "POST" && new URL(request.url).pathname === "/start";
    if (isStart && response.ok) this.installOutputLocalizerV32();
    return response;
  }

  private installOutputLocalizerV32(): void {
    if (this.outputLocalizerInstalledV32) return;
    this.outputLocalizerInstalledV32 = true;

    installRealtimeToolResultTransform(this as any, (request) => {
      const localized = localizeReservationSearchToolResult(request);
      if (localized !== request) {
        const output = localized.output as Record<string, unknown>;
        const options = Array.isArray(output.options) ? output.options : [];
        (this as any).diagnostics?.checkpoint?.("RESERVATION_SEARCH_LOCAL_TIME_ENRICHED_V32", {
          option_count: options.length,
          timezone: "Europe/Madrid",
          business_hours_authoritative: true,
          provider_boundary: "realtime_tool_result_transform",
        });
      }
      return localized;
    });
  }
}

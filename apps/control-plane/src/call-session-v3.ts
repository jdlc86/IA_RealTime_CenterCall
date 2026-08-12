import { CallSession as BaseCallSession } from "./call-session-v2";
import {
  decideCallerMatchConsent,
  normalizeE164,
  validateMarketingConsentFlowArgs,
  type MarketingConsentFlowArgs,
} from "./marketing-consent-flow";
import { SupabaseMarketingConsentStore } from "./marketing-consent-store";
import { withResolvedReservationContact, type ReservationFlowArgs } from "./reservation-flow";
import type { DataRequirement } from "./semantic-router";
import { ToolGateway, type ToolDefinition, type ToolRequest, type ToolResult } from "./tool-gateway";

const MANAGE_RESERVATION = "manage_reservation";
const MANAGE_MARKETING_CONSENT = "manage_marketing_consent";
const CONSENT_TEXT_VERSION = "voice-marketing-v2";

type RealtimeFunctionTool = {
  type: "function";
  name: string;
  description: string;
  parameters: Record<string, unknown>;
};

const RESERVATION_TOOL_V2: RealtimeFunctionTool = {
  type: "function",
  name: MANAGE_RESERVATION,
  description: "Gestiona progresivamente una reserva de restaurante. Consulta disponibilidad real y exige confirmación explícita antes de escribir. Si el usuario acepta usar el mismo número desde el que llama como contacto, usa use_caller_phone=true y no le pidas que lo dicte.",
  parameters: {
    type: "object",
    properties: {
      party_size: { type: "integer", minimum: 1, maximum: 100 },
      starts_at: { type: "string", description: "Fecha y hora ISO 8601 con zona horaria; omitir si no es inequívoca." },
      customer_name: { type: "string" },
      customer_phone: { type: "string", description: "Teléfono E.164 solo cuando el usuario proporciona expresamente un número distinto o concreto." },
      use_caller_phone: { type: "boolean", description: "true únicamente si el usuario acepta explícitamente usar como contacto el mismo número desde el que está llamando." },
      duration_minutes: { type: "integer", minimum: 15, maximum: 480 },
      notes: { type: "string" },
      confirm: { type: "boolean", description: "true únicamente tras una confirmación explícita posterior de los mismos datos." },
    },
    additionalProperties: false,
  },
};

const MARKETING_CONSENT_TOOL: RealtimeFunctionTool = {
  type: "function",
  name: MANAGE_MARKETING_CONSENT,
  description: "Registra de forma separada el alta, rechazo o baja de promociones para el mismo número desde el que entra la llamada. Nunca autoriza ni revoca automáticamente otro número.",
  parameters: {
    type: "object",
    properties: {
      action: { type: "string", enum: ["GRANT", "DECLINE", "REVOKE"], description: "GRANT solo tras un sí explícito; DECLINE tras rechazo explícito; REVOKE cuando pide dejar de recibir promociones." },
      target_phone: { type: "string", description: "Opcional. Incluir solo si el usuario menciona explícitamente un número. Si es distinto del caller, el backend rechazará la operación automática." },
    },
    required: ["action"],
    additionalProperties: false,
  },
};

const BaseConstructor = BaseCallSession as unknown as new (...args: any[]) => any;
const BasePrototype = BaseCallSession.prototype as any;

function requireRuntimeString(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`Missing runtime configuration: ${name}`);
  return value.trim();
}

export class CallSession extends BaseConstructor {
  private callerPhone: string | null = null;

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "POST" && url.pathname === "/caller-context") {
      let body: { caller_phone?: unknown };
      try {
        body = (await request.json()) as { caller_phone?: unknown };
      } catch {
        return Response.json({ ok: false, error: "invalid_json" }, { status: 400 });
      }

      if (typeof body.caller_phone !== "string") {
        return Response.json({ ok: false, error: "invalid_caller_phone" }, { status: 400 });
      }

      let phone: string;
      try {
        phone = normalizeE164(body.caller_phone);
      } catch {
        return Response.json({ ok: false, error: "invalid_caller_phone" }, { status: 400 });
      }

      if (this.callerPhone && this.callerPhone !== phone) {
        return Response.json({ ok: false, error: "caller_context_mismatch" }, { status: 409 });
      }

      this.callerPhone = phone;
      return Response.json({ ok: true, caller_phone_present: true });
    }

    return super.fetch(request);
  }

  private async executeReservationFlow(args: ReservationFlowArgs, tenantId: string): Promise<Record<string, unknown>> {
    const resolved = withResolvedReservationContact(args, this.callerPhone);
    return BasePrototype.executeReservationFlow.call(this, resolved, tenantId) as Promise<Record<string, unknown>>;
  }

  private async executeMarketingConsentFlow(args: MarketingConsentFlowArgs, tenantId: string): Promise<Record<string, unknown>> {
    const decision = decideCallerMatchConsent(args, this.callerPhone);
    if (!decision.allowed) {
      return decision.stage === "OTHER_PHONE_REQUIRES_ALTERNATIVE"
        ? {
            stage: "OTHER_PHONE_REQUIRES_ALTERNATIVE",
            changed: false,
            instruction: "No modifiques el consentimiento del otro número. Explica de forma amable que por seguridad esta llamada solo puede gestionar automáticamente las promociones del mismo número desde el que se está llamando. No afirmes que existe todavía una transferencia humana o una app operativa.",
          }
        : {
            stage: "CALLER_NUMBER_UNAVAILABLE",
            changed: false,
            instruction: "No modifiques ningún consentimiento. Explica brevemente que no puedes verificar automáticamente el número de esta llamada y que no se ha realizado ningún cambio.",
          };
    }

    const callId = requireRuntimeString((this as any).callId, "call_id");
    const store = new SupabaseMarketingConsentStore({
      SUPABASE_URL: requireRuntimeString((this as any).env?.SUPABASE_URL, "SUPABASE_URL"),
      SUPABASE_SECRET_KEY: requireRuntimeString((this as any).env?.SUPABASE_SECRET_KEY, "SUPABASE_SECRET_KEY"),
    });
    const event = await store.record(tenantId, {
      action: decision.action,
      phone: decision.phone,
      callerPhone: decision.phone,
      callId,
      consentTextVersion: CONSENT_TEXT_VERSION,
      verificationMethod: decision.verificationMethod,
    });

    if (decision.action === "GRANT") {
      return {
        stage: "MARKETING_GRANTED",
        changed: true,
        status: event.status,
        verification_method: decision.verificationMethod,
        instruction: "Confirma de forma amable que ha quedado registrado que desea recibir promociones en este mismo número. No lo mezcles con el estado de la reserva y recuerda que podrá pedir la baja posteriormente.",
      };
    }

    if (decision.action === "DECLINE") {
      return {
        stage: "MARKETING_DECLINED",
        changed: true,
        status: event.status,
        instruction: "Agradece la respuesta y confirma brevemente que no se ha activado el envío de promociones. Esto no afecta a ninguna reserva.",
      };
    }

    return {
      stage: "MARKETING_REVOKED",
      changed: true,
      status: event.status,
      verification_method: decision.verificationMethod,
      instruction: "Confirma de forma amable que este mismo número ha quedado dado de baja de promociones.",
    };
  }

  private createToolGateway(): ToolGateway {
    const baseGateway = BasePrototype.createToolGateway.call(this) as ToolGateway;
    const tenantId = requireRuntimeString((this as any).tenantId, "tenant_id");
    const allowedTools = Array.isArray((this as any).allowedTools) ? (this as any).allowedTools as string[] : [];

    const marketingDefinition: ToolDefinition<MarketingConsentFlowArgs, Record<string, unknown>> = {
      name: MANAGE_MARKETING_CONSENT,
      access: "WRITE",
      description: MARKETING_CONSENT_TOOL.description,
      validate: validateMarketingConsentFlowArgs,
      execute: async (args, context) => this.executeMarketingConsentFlow(args, context.tenantId),
    };
    const marketingGateway = new ToolGateway([marketingDefinition as ToolDefinition<unknown, unknown>], [{ tenantId, allowedTools }]);

    return {
      execute: async (request: ToolRequest): Promise<ToolResult> => request.name === MANAGE_MARKETING_CONSENT
        ? marketingGateway.execute(request)
        : baseGateway.execute(request),
    } as ToolGateway;
  }

  private forceToolForRequirement(requirement: DataRequirement): void {
    if (requirement !== "RESERVATION" && requirement !== "MARKETING_CONSENT") {
      BasePrototype.forceToolForRequirement.call(this, requirement);
      return;
    }

    const tool = requirement === "RESERVATION" ? RESERVATION_TOOL_V2 : MARKETING_CONSENT_TOOL;
    const allowedTools = Array.isArray((this as any).allowedTools) ? (this as any).allowedTools as string[] : [];
    const diagnostics = (this as any).diagnostics;

    if (!allowedTools.includes(tool.name)) {
      diagnostics?.fail?.("TOOL_NOT_AVAILABLE", "REQUIRED_TOOL_NOT_ALLOWED", { data_requirement: requirement, required_tool: tool.name });
      (this as any).createSpokenResponse(
        requirement === "RESERVATION"
          ? "No puedes completar ni confirmar una reserva porque la herramienta autorizada de reservas no está habilitada para este tenant. Indícalo brevemente sin inventar disponibilidad ni confirmar ninguna reserva."
          : "No puedes modificar preferencias de promociones porque la herramienta autorizada de consentimiento no está habilitada para este tenant. Indica brevemente que no se ha realizado ningún cambio.",
      );
      return;
    }

    (this as any).send({
      type: "response.create",
      response: {
        tool_choice: { type: "function", name: tool.name },
        tools: [tool],
        instructions: requirement === "RESERVATION"
          ? "Gestiona la reserva exclusivamente mediante manage_reservation. Si el usuario acepta usar como contacto el mismo número desde el que llama, usa use_caller_phone=true y no le pidas que lo dicte. Si proporciona otro número, usa customer_phone. Pasa solo datos proporcionados o confirmados y no marques confirm=true salvo confirmación explícita posterior."
          : "Gestiona exclusivamente mediante manage_marketing_consent. Usa GRANT solo después de un sí explícito a recibir promociones, DECLINE tras un no explícito y REVOKE cuando pide darse de baja. Para el mismo número de la llamada omite target_phone; nunca inventes ni deduzcas otro número.",
      },
    });
    diagnostics?.checkpoint?.("TOOL_FORCED", { data_requirement: requirement, tool: tool.name });
  }
}

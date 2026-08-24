import {
  requireGeminiMediaEdgeProvisioningReady,
  type GeminiMediaEdgeCredentialIssuer,
  type GeminiMediaEdgeProvisioningInput,
} from "./gemini-media-edge-admission-composition.js";
import type { GeminiMediaEdgeBootstrapRegistrationInput } from "./gemini-media-edge-bootstrap-registration.js";
import {
  geminiMediaEdgeTelnyxStartRequest,
  type GeminiMediaEdgeSessionContract,
} from "./gemini-media-edge-session-contract.js";
import type { RealtimeProviderSelection } from "./realtime-provider-selector.js";
import {
  authorizeRealtimeProviderTraffic,
  type RealtimeProviderTrafficAdmission,
  type RealtimeProviderTrafficPolicy,
} from "./realtime-provider-traffic-admission.js";
import type { TenantConfiguration, TenantResolutionV1 } from "./tenant-kv.js";
import type {
  TelnyxGeminiInboundAnswerRequest,
  TelnyxGeminiStreamingCommandResult,
  TelnyxGeminiStreamingStartRequest,
} from "./telnyx-gemini-streaming-port.js";

export type GeminiInboundTenantContext = Readonly<{
  resolution: TenantResolutionV1;
  configuration: TenantConfiguration;
}>;

export type GeminiInboundCallerSecurityDecision = Readonly<{
  decision: "ALLOW" | "BLOCK";
  reason?: string;
}>;

export type GeminiMediaEdgeInboundAdmissionInput = Readonly<{
  calledNumber: string;
  callerPhone: string;
  answerCommandId: string;
  commandId: string;
  clientState?: string;
  provisioning: GeminiMediaEdgeProvisioningInput;
  trafficPolicy: RealtimeProviderTrafficPolicy;
  controlPlaneToken: string;
}>;

export type GeminiMediaEdgeCallSessionStart = Readonly<{
  tenant: GeminiInboundTenantContext;
  selection: RealtimeProviderSelection & Readonly<{ provider: "GEMINI" }>;
  admission: RealtimeProviderTrafficAdmission;
  contract: GeminiMediaEdgeSessionContract;
}>;

export type GeminiMediaEdgeSidebandReadinessInput = Readonly<{
  callSession: object;
  selection: RealtimeProviderSelection & Readonly<{ provider: "GEMINI" }>;
  contract: GeminiMediaEdgeSessionContract;
  controlPlaneToken: string;
}>;

export type GeminiMediaEdgeInboundAdmissionDependencies = Readonly<{
  resolveTenant(calledNumber: string): Promise<GeminiInboundTenantContext | null>;
  selectProvider(configuration: TenantConfiguration): Promise<RealtimeProviderSelection>;
  evaluateCallerSecurity(input: Readonly<{
    tenantId: string;
    callerPhone: string;
    provider: "GEMINI";
  }>): Promise<GeminiInboundCallerSecurityDecision>;
  issueCredential: GeminiMediaEdgeCredentialIssuer;
  registerBootstrap(input: GeminiMediaEdgeBootstrapRegistrationInput): Promise<void>;
  startCallSession(input: GeminiMediaEdgeCallSessionStart): Promise<object>;
  requireSidebandReady(input: GeminiMediaEdgeSidebandReadinessInput): Promise<void>;
  answerCall(request: TelnyxGeminiInboundAnswerRequest): Promise<TelnyxGeminiStreamingCommandResult>;
  startStreaming(request: TelnyxGeminiStreamingStartRequest): Promise<TelnyxGeminiStreamingCommandResult>;
}>;

export type GeminiMediaEdgeInboundAdmissionResult = Readonly<{
  tenant: GeminiInboundTenantContext;
  selection: RealtimeProviderSelection & Readonly<{ provider: "GEMINI" }>;
  admission: RealtimeProviderTrafficAdmission;
  contract: GeminiMediaEdgeSessionContract;
  answering: TelnyxGeminiStreamingCommandResult;
  streaming: TelnyxGeminiStreamingCommandResult;
}>;

function required(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${field} is required`);
  return value.trim();
}

function requireGeminiSelection(
  selection: RealtimeProviderSelection,
  tenant: GeminiInboundTenantContext,
): RealtimeProviderSelection & Readonly<{ provider: "GEMINI" }> {
  const tenantId = required(tenant.resolution.tenantId, "Gemini admission resolved tenant_id");
  if (tenant.configuration.tenantId !== tenantId || selection.tenantId !== tenantId) {
    throw new Error("Gemini admission tenant/provider selection binding mismatch");
  }
  if (selection.provider !== "GEMINI") {
    throw new Error(`Gemini admission requires immutable GEMINI selection, got ${selection.provider}`);
  }
  return Object.freeze({ ...selection, provider: "GEMINI" as const });
}

/**
 * The single effect-owning admission sequence for the controlled Gemini canary.
 * Every dependency boundary is awaited, and streaming_start is deliberately the
 * final effect. There is no alternate-provider or failover branch.
 */
export async function admitGeminiMediaEdgeInboundCall(
  input: GeminiMediaEdgeInboundAdmissionInput,
  dependencies: GeminiMediaEdgeInboundAdmissionDependencies,
): Promise<GeminiMediaEdgeInboundAdmissionResult> {
  const calledNumber = required(input.calledNumber, "Gemini admission called number");
  const callerPhone = required(input.callerPhone, "Gemini admission caller phone");
  const answerCommandId = required(input.answerCommandId, "Gemini admission answer command_id");
  const commandId = required(input.commandId, "Gemini admission streaming command_id");
  const controlPlaneToken = required(input.controlPlaneToken, "Gemini admission control-plane token");

  const tenant = await dependencies.resolveTenant(calledNumber);
  if (!tenant) throw new Error("Gemini admission tenant was not resolved");

  const selection = requireGeminiSelection(
    await dependencies.selectProvider(tenant.configuration),
    tenant,
  );
  const admission = authorizeRealtimeProviderTraffic(selection, input.trafficPolicy);

  const security = await dependencies.evaluateCallerSecurity({
    tenantId: selection.tenantId,
    callerPhone,
    provider: "GEMINI",
  });
  if (security?.decision !== "ALLOW") {
    throw new Error(`Gemini admission caller security rejected: ${security?.reason?.trim() || "BLOCK"}`);
  }

  const provisioned = await requireGeminiMediaEdgeProvisioningReady(
    selection,
    input.provisioning,
    dependencies.issueCredential,
    admission,
  );

  await dependencies.registerBootstrap({
    credentialId: provisioned.credentialId,
    binding: provisioned.contract.binding,
    context: {
      assistantName: tenant.configuration.assistant.name,
      businessName: tenant.configuration.business.displayName,
    },
    controlPlaneToken,
  });

  const callSession = await dependencies.startCallSession({
    tenant,
    selection,
    admission,
    contract: provisioned.contract,
  });
  if (!callSession || typeof callSession !== "object") {
    throw new Error("Gemini admission CallSession did not start");
  }

  await dependencies.requireSidebandReady({
    callSession,
    selection,
    contract: provisioned.contract,
    controlPlaneToken,
  });

  const answering = await dependencies.answerCall({
    callControlId: provisioned.contract.binding.callControlId,
    commandId: answerCommandId,
  });
  if (!answering.ok) {
    throw new Error(`Gemini admission answer failed: ${answering.error ?? `HTTP ${answering.httpStatus ?? "unknown"}`}`);
  }

  const streaming = await dependencies.startStreaming(
    geminiMediaEdgeTelnyxStartRequest(
      provisioned.contract,
      commandId,
      input.clientState,
    ),
  );
  if (!streaming.ok) {
    throw new Error(`Gemini admission streaming_start failed: ${streaming.error ?? `HTTP ${streaming.httpStatus ?? "unknown"}`}`);
  }

  return Object.freeze({
    tenant,
    selection,
    admission,
    contract: provisioned.contract,
    answering,
    streaming,
  });
}

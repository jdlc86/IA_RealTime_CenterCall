import {
  consumeGeminiMediaEdgeCredentialOnce,
  verifyGeminiMediaEdgeCredential,
  type GeminiMediaEdgeAuthorizedCredential,
  type GeminiMediaEdgeCredentialConsumer,
  type GeminiMediaEdgeCredentialVerifier,
} from "./gemini-media-edge-credential-consumption.js";
import {
  requireGeminiMediaEdgeTelnyxStart,
  type GeminiMediaEdgeVerifiedTelnyxStart,
} from "./gemini-media-edge-telnyx-start-authority.js";

export type GeminiMediaEdgeStartAuthorization = Readonly<{
  credential: GeminiMediaEdgeAuthorizedCredential;
  telnyxStart: GeminiMediaEdgeVerifiedTelnyxStart;
}>;

export type GeminiMediaEdgeStartAuthorizationInput = Readonly<{
  rawCredential: string;
  telnyxStartFrame: unknown;
  verifyNowEpochMs: number;
  consumeNowEpochMs: number;
}>;

/**
 * Authorizes the media session in security-sensitive order:
 *
 * 1. authenticate/resolve the presented credential without consuming it;
 * 2. prove Telnyx `start.call_control_id` and media format match that binding;
 * 3. atomically consume the credential immediately before media acceptance.
 *
 * A wrong-call/malformed start therefore cannot burn a valid one-shot credential,
 * while a replay that reaches the correct call identity is rejected by the shared
 * atomic consumer before any media is accepted.
 */
export async function requireGeminiMediaEdgeStartAuthorization(
  input: GeminiMediaEdgeStartAuthorizationInput,
  verifyCredential: GeminiMediaEdgeCredentialVerifier,
  consumeCredentialOnce: GeminiMediaEdgeCredentialConsumer,
): Promise<GeminiMediaEdgeStartAuthorization> {
  const credential = await verifyGeminiMediaEdgeCredential(
    input.rawCredential,
    input.verifyNowEpochMs,
    verifyCredential,
  );
  const telnyxStart = requireGeminiMediaEdgeTelnyxStart(
    credential.binding,
    input.telnyxStartFrame,
  );
  await consumeGeminiMediaEdgeCredentialOnce(
    credential,
    input.consumeNowEpochMs,
    consumeCredentialOnce,
  );

  return Object.freeze({ credential, telnyxStart });
}

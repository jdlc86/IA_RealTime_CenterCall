export * from "./runtime-core.mjs";

import { createGeminiMediaEdgeRuntime as createCoreRuntime } from "./runtime-core.mjs";
import { bindNextCallerInputDiagnosticContext } from "./caller-input.mjs";

/**
 * Observability composition wrapper around the proven media runtime. It does not
 * alter wire ordering or media ownership. The core constructs one caller-input
 * owner synchronously and immediately emits MEDIA_SOCKET_AUTHORIZED; that stage
 * binds the just-created owner to the authenticated tenant/call identity before
 * any Telnyx media can be processed.
 */
export function createGeminiMediaEdgeRuntime(options) {
  const downstream = typeof options?.observeDiagnostic === "function" ? options.observeDiagnostic : () => {};
  const observeDiagnostic = (diagnostic) => {
    if (diagnostic?.stage === "MEDIA_SOCKET_AUTHORIZED") {
      bindNextCallerInputDiagnosticContext({
        tenantId: diagnostic.tenantId,
        callControlId: diagnostic.callControlId,
      });
    }
    downstream(diagnostic);
  };
  return createCoreRuntime({
    ...options,
    observeDiagnostic,
    callerInputOptions: {
      ...(options?.callerInputOptions ?? {}),
      observeDiagnostic,
    },
  });
}

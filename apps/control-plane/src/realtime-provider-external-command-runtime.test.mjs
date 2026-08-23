import { describe, expect, it } from "vitest";
import {
  externalRealtimeProviderCommandPortFor,
  installExternalRealtimeProviderCommandPort,
  removeExternalRealtimeProviderCommandPort,
} from "./realtime-provider-external-command-runtime";

function fakePort(label) {
  return {
    label,
    speak() {}, requestTextDecision() {}, createSemanticResponse() {}, submitToolResult() {},
    updateSessionPolicy() {}, setSemanticToolGate() {}, createDefaultResponse() {}, cancelResponse() {},
    clearPlayback() {}, clearInput() {}, discardInputItem() {}, suspendInputDetection() {},
    beginNonInterruptingListening() {}, restoreInputDetection() {},
  };
}

describe("external realtime provider command runtime", () => {
  it("installs and releases a provider-scoped command capability", () => {
    const host = {};
    const port = fakePort("gemini");
    installExternalRealtimeProviderCommandPort(host, "GEMINI", port);
    expect(externalRealtimeProviderCommandPortFor(host, "GEMINI")).toBe(port);
    removeExternalRealtimeProviderCommandPort(host, "GEMINI", port);
    expect(externalRealtimeProviderCommandPortFor(host, "GEMINI")).toBeNull();
  });

  it("fails closed on provider affinity or ownership mismatch", () => {
    const host = {};
    const first = fakePort("first");
    const second = fakePort("second");
    installExternalRealtimeProviderCommandPort(host, "GEMINI", first);
    expect(() => externalRealtimeProviderCommandPortFor(host, "OPENAI")).toThrow(/affinity mismatch/);
    expect(() => installExternalRealtimeProviderCommandPort(host, "GEMINI", second)).toThrow(/already installed/);
    expect(() => removeExternalRealtimeProviderCommandPort(host, "GEMINI", second)).toThrow(/ownership mismatch/);
  });
});

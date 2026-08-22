import type { ControllerCloseAssessment } from "./core-closing-policy.js";

export class ClosingSessionRuntime {
  private confirmationPending = false;
  private assessment: ControllerCloseAssessment = { courtesy: false, closeIntent: "ABSTAIN" };

  isConfirmationPending(): boolean { return this.confirmationPending; }
  setConfirmationPending(value: boolean): void { this.confirmationPending = value; }

  controllerAssessment(): ControllerCloseAssessment { return { ...this.assessment }; }
  setControllerAssessment(value: ControllerCloseAssessment): void { this.assessment = { ...value }; }
  resetControllerAssessment(): void { this.assessment = { courtesy: false, closeIntent: "ABSTAIN" }; }
}

const runtimes = new WeakMap<object, ClosingSessionRuntime>();
export function closingSessionRuntimeFor(session: object): ClosingSessionRuntime {
  let runtime = runtimes.get(session);
  if (!runtime) { runtime = new ClosingSessionRuntime(); runtimes.set(session, runtime); }
  return runtime;
}

import type { RealtimeInputDetectionSettings } from "./realtime-provider-command-port.js";

export class InputDetectionConfigRuntime {
  private settings: RealtimeInputDetectionSettings = {};

  set(settings: RealtimeInputDetectionSettings | null | undefined): void {
    this.settings = settings ? { ...settings } : {};
  }

  get(): RealtimeInputDetectionSettings {
    return { ...this.settings };
  }
}

const runtimes = new WeakMap<object, InputDetectionConfigRuntime>();

export function inputDetectionConfigRuntimeFor(session: object): InputDetectionConfigRuntime {
  let runtime = runtimes.get(session);
  if (!runtime) {
    runtime = new InputDetectionConfigRuntime();
    runtimes.set(session, runtime);
  }
  return runtime;
}

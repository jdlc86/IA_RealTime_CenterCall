import { CallSession as CallSessionV35 } from "./call-session-v35";

const BaseConstructor = CallSessionV35 as unknown as new (...args: any[]) => any;
const CALLSESSION_RUNTIME_FINGERPRINT = "v35-protected-speech-runtime-2026-08-15-a";

/**
 * Temporary deployment diagnostic wrapper.
 *
 * This class does not alter Realtime, VAD, tools, watchdogs, or protected-speech
 * behavior. It only records an unambiguous fingerprint after a successful
 * CallSession /start so production calls can prove which Durable Object code is
 * actually executing.
 */
export class CallSession extends BaseConstructor {
  async fetch(request: Request): Promise<Response> {
    const isStart = request.method === "POST" && new URL(request.url).pathname === "/start";
    const response = await super.fetch(request);

    if (isStart && response.ok) {
      (this as any).diagnostics?.checkpoint?.("CALLSESSION_RUNTIME_FINGERPRINT_V35", {
        fingerprint: CALLSESSION_RUNTIME_FINGERPRINT,
      });
    }

    return response;
  }
}

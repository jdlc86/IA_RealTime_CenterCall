export const DEFAULT_GEMINI_LIVE_MODEL = "gemini-3.1-flash-live-preview" as const;
const GEMINI_LIVE_ENDPOINT = "wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent";

export type GeminiLiveWebSocket = Pick<WebSocket,
  "readyState" | "send" | "close" | "addEventListener" | "removeEventListener"
>;

export type GeminiLiveWebSocketFactory = (url: string) => GeminiLiveWebSocket;

export function buildGeminiLiveWebSocketUrl(apiKey: string): string {
  const key = apiKey.trim();
  if (!key) throw new Error("Gemini Live API key is required");
  const url = new URL(GEMINI_LIVE_ENDPOINT);
  url.searchParams.set("key", key);
  return url.toString();
}

/**
 * Open one provider-scoped Live websocket. Authentication is intentionally kept
 * inside this edge connector; callers receive the socket but never the URL/token.
 * Failures use generic messages so an exception cannot disclose the API key.
 */
export function connectGeminiLiveWebSocket(
  apiKey: string,
  factory: GeminiLiveWebSocketFactory = (url) => new WebSocket(url),
): Promise<GeminiLiveWebSocket> {
  const url = buildGeminiLiveWebSocketUrl(apiKey);
  let socket: GeminiLiveWebSocket;
  try {
    socket = factory(url);
  } catch {
    throw new Error("Gemini Live websocket construction failed");
  }

  return new Promise((resolve, reject) => {
    let settled = false;
    const cleanup = () => {
      socket.removeEventListener("open", onOpen as EventListener);
      socket.removeEventListener("error", onError as EventListener);
      socket.removeEventListener("close", onClose as EventListener);
    };
    const fail = (message: string) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new Error(message));
    };
    const onOpen = () => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(socket);
    };
    const onError = () => fail("Gemini Live websocket connection failed");
    const onClose = () => fail("Gemini Live websocket closed before ready");

    socket.addEventListener("open", onOpen as EventListener);
    socket.addEventListener("error", onError as EventListener);
    socket.addEventListener("close", onClose as EventListener);
  });
}

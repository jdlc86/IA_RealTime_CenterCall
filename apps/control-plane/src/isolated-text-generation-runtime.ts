export type IsolatedTextGenerationRequest = Readonly<{
  instructions: string;
  inputText: string;
  maxOutputTokens?: number;
}>;

export type IsolatedTextGenerationPort = Readonly<{
  generate(request: IsolatedTextGenerationRequest): Promise<string>;
}>;

const ports = new WeakMap<object, IsolatedTextGenerationPort>();

export function installIsolatedTextGenerationPort(host: object, port: IsolatedTextGenerationPort): void {
  if (!host || typeof host !== "object") throw new Error("Isolated text generation host is required");
  if (!port || typeof port.generate !== "function") throw new Error("Isolated text generation port is required");
  if (ports.has(host)) throw new Error("Isolated text generation port is already installed for this session");
  ports.set(host, port);
}

export function removeIsolatedTextGenerationPort(host: object, port: IsolatedTextGenerationPort): void {
  if (ports.get(host) !== port) throw new Error("Isolated text generation port ownership mismatch");
  ports.delete(host);
}

export function optionalIsolatedTextGenerationPortFor(host: object): IsolatedTextGenerationPort | null {
  return ports.get(host) ?? null;
}

export function isolatedTextGenerationPortFor(host: object): IsolatedTextGenerationPort {
  const port = optionalIsolatedTextGenerationPortFor(host);
  if (!port) throw new Error("Isolated text generation port is not installed for this session");
  return port;
}

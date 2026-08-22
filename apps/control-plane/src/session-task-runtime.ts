export type SessionTask = () => void | Promise<void>;

export type SessionTaskRuntimeOptions = Readonly<{
  waitUntil?: (promise: Promise<void>) => void;
  onError?: (label: string, error: unknown) => void;
}>;

/**
 * Single owner for asynchronous work that belongs to one call session.
 *
 * Event tasks are serialized in arrival order. Background tasks may perform
 * independent I/O, but must enqueue their state-changing completion through
 * this same runtime. Every task is attached to the Durable Object lifetime.
 */
export class SessionTaskRuntime {
  private tail: Promise<void> = Promise.resolve();
  private waitUntil: ((promise: Promise<void>) => void) | null = null;
  private onError: ((label: string, error: unknown) => void) | null = null;

  configure(options: SessionTaskRuntimeOptions): this {
    if (options.waitUntil) this.waitUntil = options.waitUntil;
    if (options.onError) this.onError = options.onError;
    return this;
  }

  enqueue(label: string, task: SessionTask): void {
    const execution = this.tail.then(task);
    const settled = execution.catch((error) => this.report(label, error));
    this.tail = settled;
    this.own(settled);
  }

  runInBackground(label: string, task: SessionTask): void {
    const settled = Promise.resolve().then(task).catch((error) => this.report(label, error));
    this.own(settled);
  }

  whenIdle(): Promise<void> {
    return this.tail;
  }

  private own(promise: Promise<void>): void {
    this.waitUntil?.(promise);
  }

  private report(label: string, error: unknown): void {
    if (this.onError) {
      try {
        this.onError(label, error);
        return;
      } catch (reportingError) {
        console.error(JSON.stringify({
          level: "error",
          event: "session_task_error_report_failed",
          task: label,
          error: reportingError instanceof Error ? reportingError.message : String(reportingError),
        }));
      }
    }
    console.error(JSON.stringify({
      level: "error",
      event: "session_task_failed",
      task: label,
      error: error instanceof Error ? error.message : String(error),
    }));
  }
}

const runtimes = new WeakMap<object, SessionTaskRuntime>();

export function sessionTaskRuntimeFor(session: object): SessionTaskRuntime {
  let runtime = runtimes.get(session);
  if (!runtime) {
    runtime = new SessionTaskRuntime();
    runtimes.set(session, runtime);
  }
  return runtime;
}

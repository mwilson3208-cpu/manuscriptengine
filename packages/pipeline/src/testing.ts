import type { AIClient, AIRequest, AIResponse } from "./ai";

export type FakeHandler = (req: AIRequest, call: number) => string | Partial<AIResponse> | Error;

/** Deterministic AI client for tests. The handler sees every request in order. */
export class FakeAI implements AIClient {
  readonly requests: AIRequest[] = [];
  constructor(private readonly handler: FakeHandler) {}

  async complete(req: AIRequest): Promise<AIResponse> {
    this.requests.push(req);
    const r = this.handler(req, this.requests.length);
    if (r instanceof Error) throw r;
    const base: AIResponse = { text: "", model: "fake-model", tokensIn: 100, tokensOut: 50, stopReason: "end_turn" };
    return typeof r === "string" ? { ...base, text: r } : { ...base, ...r };
  }
}

/** Route fake responses by the task of the template that produced the request. */
export function routeByTask(routes: Record<string, (req: AIRequest, call: number) => string | Error>): FakeHandler {
  return (req, call) => {
    const task = req.promptVersion.split("@")[0] ?? "";
    const fn = routes[task];
    if (!fn) return new Error(`FakeAI: no route for task ${task}`);
    return fn(req, call);
  };
}

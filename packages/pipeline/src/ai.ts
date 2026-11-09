import Anthropic from "@anthropic-ai/sdk";

export interface AIRequest {
  /** A setting key from template front matter (for example "sonnet"), resolved by the client. */
  modelKey: string;
  system: string;
  user: string;
  maxTokens: number;
  /** Template id, for example "chapter@1.0.0". Used for logging and test routing. */
  promptVersion: string;
}

export interface AIResponse {
  text: string;
  model: string;
  tokensIn: number;
  tokensOut: number;
  stopReason: string | null;
}

/** Every AI call in the pipeline goes through this interface, so tests inject a fake. */
export interface AIClient {
  complete(req: AIRequest): Promise<AIResponse>;
}

export interface ModelSettings {
  /** Setting key to model ID, for example { sonnet: "claude-sonnet-5-5" }. */
  models: Record<string, string>;
  /** Optional per-task override of the template's model key, for example { brief: "opus" }. */
  task_models?: Record<string, string>;
  /** Optional effort level passed to the API. Null leaves the model default. */
  effort?: "low" | "medium" | "high" | "xhigh" | "max" | null;
  /** Use the server-side refusal fallback on models that support it. API provider only. */
  refusal_fallback?: boolean;
  /** "claude-cli" runs calls through the operator's Claude Code login; "api" uses ANTHROPIC_API_KEY; "auto" picks api when a key is set. */
  provider?: "auto" | "api" | "claude-cli";
}

export class AIError extends Error {
  override name = "AIError";
  constructor(
    message: string,
    readonly retryable: boolean,
  ) {
    super(message);
  }
}

export function resolveModel(settings: ModelSettings, modelKey: string): string {
  const id = settings.models[modelKey];
  if (!id) throw new AIError(`No model configured for setting key "${modelKey}"`, false);
  return id;
}

/**
 * Anthropic implementation. Streams every request so long chapters and edit
 * passes never hit HTTP timeouts, then reads the final message.
 */
export function createAnthropicClient(settings: ModelSettings, apiKey = process.env.ANTHROPIC_API_KEY): AIClient {
  const client = new Anthropic(apiKey ? { apiKey } : {});
  return {
    async complete(req) {
      const model = resolveModel(settings, req.modelKey);
      try {
        const stream = client.beta.messages.stream({
          model,
          max_tokens: req.maxTokens,
          system: req.system,
          messages: [{ role: "user", content: req.user }],
          ...(settings.effort ? { output_config: { effort: settings.effort } } : {}),
          ...(settings.refusal_fallback ? { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" as const } : {}),
        });
        const message = await stream.finalMessage();
        if (message.stop_reason === "refusal") {
          throw new AIError(`Model declined the request (${message.stop_details?.category ?? "no category"})`, false);
        }
        const text = message.content
          .flatMap((b) => (b.type === "text" ? [b.text] : []))
          .join("")
          .trim();
        return {
          text,
          model: message.model,
          tokensIn: message.usage.input_tokens,
          tokensOut: message.usage.output_tokens,
          stopReason: message.stop_reason,
        };
      } catch (err) {
        if (err instanceof AIError) throw err;
        if (err instanceof Anthropic.APIError) {
          const status = err.status ?? 0;
          throw new AIError(`Anthropic API error ${status}: ${err.message}`, status === 0 || status === 408 || status === 429 || status >= 500);
        }
        throw new AIError(`AI call failed: ${(err as Error).message}`, true);
      }
    },
  };
}

import type { Logger } from './interfaces.js';

export interface AiMessage { role: 'system' | 'user' | 'assistant'; content: string }
export interface AiRequest { messages: AiMessage[]; maxTokens?: number; temperature?: number }
export interface AiReply { text: string; model: string; tokensIn: number; tokensOut: number; cost: number }

export interface AiAdapter {
  readonly kind: string;
  /** True when a model is actually reachable; false means only the offline paths will work. */
  readonly available: boolean;
  complete(req: AiRequest): Promise<AiReply>;
}

/**
 * No model configured. It refuses rather than inventing: a school that has not connected (and is not
 * paying for) an AI provider gets a clear "not available" instead of a plausible-looking answer.
 */
export class NoAi implements AiAdapter {
  readonly kind = 'none';
  readonly available = false;
  constructor(private log?: Logger) {}
  async complete(): Promise<AiReply> {
    this.log?.info('[ai] no provider configured');
    throw new Error('no AI provider is configured for this installation');
  }
}

export interface HttpAiOptions {
  /** Any OpenAI-compatible endpoint: OpenAI, Groq, OpenRouter, or a local llama.cpp server. */
  url: string;
  apiKey?: string;
  model?: string;
  costPer1kIn?: number;
  costPer1kOut?: number;
  timeoutMs?: number;
}

/** The one shape every hosted model speaks, so a school can point this at whatever it can afford. */
export class HttpAi implements AiAdapter {
  readonly kind = 'http';
  readonly available = true;
  constructor(private o: HttpAiOptions) {}
  async complete(req: AiRequest): Promise<AiReply> {
    const res = await fetch(this.o.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(this.o.apiKey ? { Authorization: `Bearer ${this.o.apiKey}` } : {}) },
      body: JSON.stringify({ model: this.o.model ?? 'gpt-4o-mini', messages: req.messages, max_tokens: req.maxTokens ?? 600, temperature: req.temperature ?? 0.3 }),
      signal: AbortSignal.timeout(this.o.timeoutMs ?? 25_000),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`ai provider ${res.status}: ${text.slice(0, 200)}`);
    const body = JSON.parse(text) as { choices?: { message?: { content?: string } }[]; usage?: { prompt_tokens?: number; completion_tokens?: number }; model?: string };
    const tokensIn = body.usage?.prompt_tokens ?? 0, tokensOut = body.usage?.completion_tokens ?? 0;
    return {
      text: body.choices?.[0]?.message?.content ?? '',
      model: body.model ?? this.o.model ?? 'unknown',
      tokensIn, tokensOut,
      cost: Math.round(((tokensIn / 1000) * (this.o.costPer1kIn ?? 0) + (tokensOut / 1000) * (this.o.costPer1kOut ?? 0)) * 10_000) / 10_000,
    };
  }
}

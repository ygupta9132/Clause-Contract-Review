/**
 * OpenRouter client: chat, streaming chat, and batched embeddings.
 *
 * Three things here exist because of how free models behave:
 *
 * 1. Free models are rate-limited per minute and per day and are sometimes simply busy. Every
 *    call retries with exponential backoff on 429 and 5xx, and surfaces a typed RateLimitError
 *    when it gives up, so the UI can say "rate-limited, try again" instead of "something failed".
 * 2. Many free models reject `response_format: json_object`. Rather than depend on it, the JSON
 *    prompt asks for raw JSON and the parser tolerates code fences and leading prose. One repair
 *    attempt is made before giving up.
 * 3. Embeddings are sent in batches. One request per chunk would exhaust a free key on the first
 *    contract.
 */
import { z } from "zod";

/**
 * Two providers, one client.
 *
 * Both speak the OpenAI chat-completions and embeddings shape, so the difference is a base URL,
 * a key and two model ids. The abstraction exists for a practical reason rather than a tidy one:
 * OpenRouter's free tier allows 50 requests per account per day, which is about four contracts,
 * and that turned out to be the binding constraint on actually using this app. Google AI Studio's
 * free tier is far larger. Being able to move between them is worth the twenty lines.
 */
const PROVIDERS = {
  openrouter: {
    baseUrl: "https://openrouter.ai/api/v1",
    keyVar: "OPENROUTER_API_KEY",
    chatVar: "OPENROUTER_CHAT_MODEL",
    embedVar: "OPENROUTER_EMBED_MODEL",
    defaultChat: "nvidia/nemotron-3-ultra-550b-a55b:free",
    defaultEmbed: "nvidia/nemotron-3.5-embed-1b:free",
  },
  gemini: {
    baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
    keyVar: "GEMINI_API_KEY",
    chatVar: "GEMINI_CHAT_MODEL",
    embedVar: "GEMINI_EMBED_MODEL",
    defaultChat: "gemini-flash-latest",
    defaultEmbed: "gemini-embedding-001",
  },
} as const;

export type ProviderName = keyof typeof PROVIDERS;

export class RateLimitError extends Error {
  constructor(message: string, readonly retryAfterSeconds?: number) {
    super(message);
    this.name = "RateLimitError";
  }
}

export class UpstreamError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
    this.name = "UpstreamError";
  }
}

export type ChatMessage = { role: "system" | "user" | "assistant"; content: string };

function config() {
  const name = (process.env.LLM_PROVIDER ?? "openrouter") as ProviderName;
  const provider = PROVIDERS[name];
  if (!provider) {
    throw new UpstreamError(
      `LLM_PROVIDER is "${name}". It must be one of: ${Object.keys(PROVIDERS).join(", ")}.`,
    );
  }

  const apiKey = process.env[provider.keyVar];
  if (!apiKey) {
    throw new UpstreamError(
      `${provider.keyVar} is not set, and LLM_PROVIDER is "${name}". Copy .env.example to .env.`,
    );
  }

  return {
    providerName: name,
    baseUrl: provider.baseUrl,
    apiKey,
    chatModel: process.env[provider.chatVar] || provider.defaultChat,
    embedModel: process.env[provider.embedVar] || provider.defaultEmbed,
    /**
     * Optional second model, tried once when the first is rate-limited.
     *
     * OpenRouter caps `:free` models per account per day, separately from the key's budget, so
     * a long day of testing can exhaust free capacity while the key still has money on it.
     * Setting this to an inexpensive paid model turns "the review stopped" into "the review
     * cost a fraction of a cent". Unset by default: nothing here spends money unasked.
     */
    fallbackChatModel: process.env.LLM_FALLBACK_CHAT_MODEL || null,
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      // OpenRouter uses these for dashboard attribution. Other providers ignore them.
      ...(name === "openrouter"
        ? {
            "HTTP-Referer": process.env.OPENROUTER_APP_URL ?? "http://localhost:3000",
            "X-Title": process.env.OPENROUTER_APP_NAME ?? "Contract Review Assistant",
          }
        : {}),
    } as Record<string, string>,
  };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * One HTTP call with retries. Retries 429 and 5xx; never retries a 4xx we caused, because a bad
 * request body retried five times is just five bad requests.
 */
async function request(path: string, body: unknown, attempt = 0): Promise<Response> {
  const { headers, baseUrl } = config();
  const MAX_ATTEMPTS = 5;

  let res: Response;
  try {
    res = await fetch(`${baseUrl}${path}`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(120_000),
    });
  } catch (err) {
    // Network error or timeout. Worth retrying.
    if (attempt + 1 >= MAX_ATTEMPTS) {
      throw new UpstreamError(`${config().providerName} unreachable: ${(err as Error).message}`);
    }
    await sleep(2 ** attempt * 1000);
    return request(path, body, attempt + 1);
  }

  if (res.ok) return res;

  if (res.status === 429 || res.status >= 500) {
    const retryAfter = Number(res.headers.get("retry-after")) || undefined;
    if (attempt + 1 >= MAX_ATTEMPTS) {
      const detail = await res.text().catch(() => "");
      if (res.status === 429) {
        throw new RateLimitError(
          `${config().providerName} rate limit reached on ${path}. ${detail.slice(0, 300)}`,
          retryAfter,
        );
      }
      throw new UpstreamError(`${config().providerName} ${res.status} on ${path}: ${detail.slice(0, 300)}`, res.status);
    }
    // Honour Retry-After when the server sends one, otherwise back off exponentially with jitter.
    const waitMs = retryAfter ? retryAfter * 1000 : 2 ** attempt * 1000 + Math.random() * 400;
    await sleep(waitMs);
    return request(path, body, attempt + 1);
  }

  const detail = await res.text().catch(() => "");
  throw new UpstreamError(`${config().providerName} ${res.status} on ${path}: ${detail.slice(0, 300)}`, res.status);
}

/** Pull the first balanced JSON object out of a model response that may be fenced or prefaced. */
export function extractJson(raw: string): unknown {
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const text = (fenced ? fenced[1] : raw).trim();

  const start = text.indexOf("{");
  if (start === -1) throw new Error("no JSON object in model output");

  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === "\\") {
      escaped = true;
      continue;
    }
    if (ch === '"') inString = !inString;
    if (inString) continue;
    if (ch === "{") depth++;
    if (ch === "}") {
      depth--;
      if (depth === 0) return JSON.parse(text.slice(start, i + 1));
    }
  }
  throw new Error("unterminated JSON object in model output");
}

/**
 * `max_tokens` is generous because the suggested chat model is a reasoning model: a measured
 * call spent 219-367 tokens thinking before writing ~150 tokens of JSON. A budget sized for the
 * answer alone gets consumed by the reasoning and returns nothing.
 */
const MAX_TOKENS = 1500;

async function completion(
  messages: ChatMessage[],
  temperature: number,
  attempt = 0,
  model?: string,
): Promise<string> {
  const MAX_ATTEMPTS = 3;
  const { chatModel, fallbackChatModel } = config();
  const useModel = model ?? chatModel;

  let res: Response;
  try {
    res = await request("/chat/completions", {
      model: useModel,
      messages,
      temperature,
      max_tokens: MAX_TOKENS,
    });
  } catch (err) {
    // One retry on a different model when the configured one has no capacity left. Only when a
    // fallback is configured, and only once, so a misconfigured fallback cannot loop.
    if (err instanceof RateLimitError && fallbackChatModel && useModel !== fallbackChatModel) {
      console.warn(`[llm] ${useModel} is rate-limited; falling back to ${fallbackChatModel}`);
      return completion(messages, temperature, 0, fallbackChatModel);
    }
    throw err;
  }
  const data = (await res.json()) as {
    choices?: { message?: { content?: string }; finish_reason?: string }[];
    error?: { message?: string };
  };
  if (data.error) throw new UpstreamError(data.error.message ?? "the model provider returned an error");

  const content = data.choices?.[0]?.message?.content;

  /**
   * An empty body with HTTP 200 is how this free tier throttles a burst. It is not a 429 and it
   * carries no Retry-After, so it has to be recognised by its shape and retried; treating it as
   * a hard failure loses the checklist item for a reason that clears itself in a second.
   */
  if (!content?.trim()) {
    if (attempt + 1 < MAX_ATTEMPTS) {
      await sleep(2 ** attempt * 1500 + Math.random() * 500);
      return completion(messages, temperature, attempt + 1, useModel);
    }
    if (fallbackChatModel && useModel !== fallbackChatModel) {
      console.warn(`[llm] ${useModel} kept returning nothing; falling back to ${fallbackChatModel}`);
      return completion(messages, temperature, 0, fallbackChatModel);
    }
    throw new UpstreamError(
      `${useModel} returned an empty completion ${MAX_ATTEMPTS} times (finish_reason: ${data.choices?.[0]?.finish_reason ?? "none"}). The free model is likely throttling.`,
    );
  }

  return content;
}

/**
 * Ask for JSON and validate it. One repair round: if the first answer does not parse or does not
 * match the schema, the error is handed back to the model, which fixes malformed output far more
 * often than a plain retry does.
 */
export async function chatJson<T>(
  messages: ChatMessage[],
  schema: z.ZodType<T>,
  temperature = 0,
): Promise<T> {
  const first = await completion(messages, temperature);
  try {
    return schema.parse(extractJson(first));
  } catch (err) {
    const repaired = await completion(
      [
        ...messages,
        { role: "assistant", content: first },
        {
          role: "user",
          content:
            `That response could not be used: ${(err as Error).message}.\n` +
            "Reply again with the JSON object only. No prose, no code fence, no trailing commas.",
        },
      ],
      0,
    );
    return schema.parse(extractJson(repaired));
  }
}

/** Streaming chat. Yields text deltas as they arrive. */
export async function* chatStream(
  messages: ChatMessage[],
  temperature = 0.1,
): AsyncGenerator<string> {
  const { chatModel } = config();
  const res = await request("/chat/completions", {
    model: chatModel,
    messages,
    temperature,
    max_tokens: 1200,
    stream: true,
  });

  const reader = res.body?.getReader();
  if (!reader) throw new UpstreamError("the model provider returned no stream body");

  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    // SSE frames are separated by a blank line; a frame can straddle two chunks.
    let nl: number;
    while ((nl = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!line.startsWith("data:")) continue;
      const payload = line.slice(5).trim();
      if (payload === "[DONE]") return;
      try {
        const parsed = JSON.parse(payload) as {
          choices?: { delta?: { content?: string } }[];
        };
        const delta = parsed.choices?.[0]?.delta?.content;
        if (delta) yield delta;
      } catch {
        // Providers send keep-alive comment frames (": OPENROUTER PROCESSING"). Ignore unparseable ones.
      }
    }
  }
}

/**
 * Embed many texts in one call per batch.
 *
 * Batch size is deliberately modest: free endpoints reject very large payloads, and a failed
 * batch of 16 costs less to retry than a failed batch of 256.
 */
export async function embedBatch(texts: string[], batchSize = 16): Promise<number[][]> {
  const { embedModel } = config();
  const out: number[][] = [];

  const dims = Number(process.env.EMBEDDING_DIMENSIONS ?? 2048);

  for (let i = 0; i < texts.length; i += batchSize) {
    const slice = texts.slice(i, i + batchSize);
    /**
     * `dimensions` asks for a narrower vector than the model's native width. Gemini's embedding
     * models are trained so a truncated vector is still a usable one, and 1536 instead of 3072
     * halves the row size and the distance computation for no measurable loss on this task.
     * Providers that ignore the parameter return their native width, which the check below
     * catches rather than letting it fail later inside an insert.
     */
    const res = await request("/embeddings", {
      model: embedModel,
      input: slice,
      dimensions: dims,
    });
    const data = (await res.json()) as {
      data?: { embedding: number[]; index: number }[];
      error?: { message?: string };
    };
    if (data.error) throw new UpstreamError(data.error.message ?? "embedding error");
    if (!data.data?.length) throw new UpstreamError("the model provider returned no embeddings");

    // The API may return results out of order; index tells us where each one belongs.
    const ordered = [...data.data].sort((a, b) => a.index - b.index);
    for (const row of ordered) out.push(row.embedding);

    // A small gap between batches keeps a long contract under the per-minute cap.
    if (i + batchSize < texts.length) await sleep(400);
  }

  if (out.length && out[0].length !== dims) {
    throw new UpstreamError(
      `Embedding model returned ${out[0].length} dimensions but EMBEDDING_DIMENSIONS is ${dims}. ` +
        "Set EMBEDDING_DIMENSIONS to match, then re-run npm run db:push.",
    );
  }
  return out;
}

export async function embedOne(text: string): Promise<number[]> {
  const [v] = await embedBatch([text], 1);
  return v;
}

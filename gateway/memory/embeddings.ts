/**
 * AgentForEach Memory Layer — Embeddings Client
 *
 * OpenAI embeddings wrapper for generating text vectors.
 *
 * API key and model are resolved from the `llms.embedding` section
 * in agentforeach.json (via MemoryConfig). The memory module does NOT
 * maintain its own API key config — it reuses the LLMs layer's
 * embedding configuration as the single source of truth.
 */

import OpenAI from "openai";
import { DEFAULT_EMBEDDING_MODEL, vectorDimsForModel } from "./config.js";

// ============================================================================
// Embeddings Client
// ============================================================================

export class EmbeddingsClient {
  private client: OpenAI;
  private model: string;
  private dimensions: number;
  private maxEmbeddingChars: number;

  constructor(apiKey: string, model?: string, maxEmbeddingChars?: number, baseUrl?: string) {
    this.client = new OpenAI({
      apiKey,
      ...(baseUrl && { baseURL: baseUrl }),
    });
    this.model = model ?? DEFAULT_EMBEDDING_MODEL;
    this.dimensions = vectorDimsForModel(this.model);
    this.maxEmbeddingChars = maxEmbeddingChars ?? 8000;
    console.log(
      `[embeddings] init: model=${this.model}, dims=${this.dimensions}, ` +
        `baseUrl=${baseUrl ?? "(default)"}, maxChars=${this.maxEmbeddingChars}`,
    );
  }

  /**
   * Generate an embedding vector for a single text string.
   *
   * @param text - The text to embed.
   * @returns Float array of length `dimensions`.
   */
  async embed(text: string): Promise<number[]> {
    const sanitized = sanitizeForEmbedding(text, this.maxEmbeddingChars);
    if (!sanitized) {
      return new Array<number>(this.dimensions).fill(0);
    }

    const response = await this.client.embeddings.create({
      model: this.model,
      input: sanitized,
      dimensions: this.dimensions,
    });

    return response.data[0].embedding;
  }

  /**
   * Generate embeddings for multiple texts in a single API call.
   *
   * @param texts - The texts to embed.
   * @returns Array of float arrays, one per input text.
   */
  async embedBatch(texts: string[]): Promise<number[][]> {
    const sanitized = texts.map((t) => sanitizeForEmbedding(t, this.maxEmbeddingChars));
    const nonEmptyIndices: number[] = [];
    const nonEmptyTexts: string[] = [];

    for (let i = 0; i < sanitized.length; i++) {
      if (sanitized[i]) {
        nonEmptyIndices.push(i);
        nonEmptyTexts.push(sanitized[i]);
      }
    }

    if (nonEmptyTexts.length === 0) {
      return texts.map(() => new Array<number>(this.dimensions).fill(0));
    }

    const response = await this.client.embeddings.create({
      model: this.model,
      input: nonEmptyTexts,
      dimensions: this.dimensions,
    });

    // Map results back to original indices
    const results: number[][] = texts.map(() =>
      new Array<number>(this.dimensions).fill(0),
    );
    for (let i = 0; i < response.data.length; i++) {
      results[nonEmptyIndices[i]] = response.data[i].embedding;
    }
    return results;
  }

  /** Get the configured model name. */
  getModel(): string {
    return this.model;
  }

  /** Get the vector dimensions for the configured model. */
  getDimensions(): number {
    return this.dimensions;
  }
}

// ============================================================================
// Helpers
// ============================================================================

/**
 * Sanitize text before sending to the embedding API.
 *
 * - Trims whitespace
 * - Collapses runs of whitespace to single spaces
 * - Truncates to max token-safe length (~8000 chars ≈ ~2000 tokens)
 */
function sanitizeForEmbedding(text: string, maxChars = 8000): string {
  let cleaned = text.trim().replace(/\s+/g, " ");
  if (cleaned.length > maxChars) {
    cleaned = cleaned.slice(0, maxChars);
  }
  return cleaned;
}

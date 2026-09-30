/* eslint-disable @typescript-eslint/no-explicit-any */
import { embedTexts } from "../../ai/ai.service";
import { env } from "../../config/env";
import { escapeRegex } from "../../utils/escapeRegex";
import { logger } from "../../utils/logger";
import { KnowledgeArticleDocument, KnowledgeArticleModel, KnowledgeChunkModel } from "./knowledge.model";

/**
 * RETRIEVAL (RAG).
 *  index:  published article → chunks of ~180 words (40-word overlap, per language) → embeddings
 *  search: MongoDB Atlas Vector Search ($vectorSearch) on the query embedding when available;
 *          otherwise (no Atlas index, no embeddings, AI down) → MongoDB text search → keyword regex.
 * Only PUBLISHED articles are ever searchable; the caller gets short passages + article titles.
 */

const CHUNK_WORDS = 180;
const OVERLAP_WORDS = 40;

export type Passage = {
  articleId: string;
  title: string;
  text: string;
  score: number;
  method: "vector" | "text" | "keyword";
};

/** Split markdown into overlapping word windows, keeping headings with their text */
export const chunkText = (markdown: string): string[] => {
  const words = markdown
    .replace(/\r/g, "")
    .replace(/[#*_`>]+/g, " ")
    .split(/\s+/)
    .filter(Boolean);
  if (!words.length) return [];
  const chunks: string[] = [];
  for (let start = 0; start < words.length; start += CHUNK_WORDS - OVERLAP_WORDS) {
    chunks.push(words.slice(start, start + CHUNK_WORDS).join(" "));
    if (start + CHUNK_WORDS >= words.length) break;
  }
  return chunks;
};

/** Rebuild the chunks (and embeddings when possible) of one article. Unpublished → removed from search. */
export const indexArticle = async (article: KnowledgeArticleDocument) => {
  await KnowledgeChunkModel.deleteMany({ article: article._id });
  if (article.status !== "published" || article.isDeleted) return { chunks: 0, method: null };

  const parts = (["en", "bn"] as const).flatMap((language) => {
    const title = language === "bn" ? article.titleBn || article.titleEn : article.titleEn || article.titleBn;
    const body = language === "bn" ? article.contentBn : article.contentEn;
    return chunkText(body).map((text) => ({ language, title, text }));
  });
  if (!parts.length) return { chunks: 0, method: null };

  const embedded = await embedTexts(
    parts.map((p) => `${p.title}\n${p.text}`),
    { feature: "knowledge-embed", promptVersion: "embed.v1", purpose: "document", entityId: String(article._id) },
  );
  await KnowledgeChunkModel.insertMany(
    parts.map((p, i) => ({
      article: article._id,
      articleVersion: article.version,
      ...p,
      ...(embedded && { embedding: embedded.vectors[i], embeddingModel: embedded.model }),
    })),
  );
  const method = embedded ? "vector" : "text";
  await KnowledgeArticleModel.updateOne({ _id: article._id }, { $set: { indexedAt: new Date(), indexMethod: method } });
  return { chunks: parts.length, method };
};

const vectorSearch = async (query: string, limit: number): Promise<Passage[] | null> => {
  const q = await embedTexts([query], {
    feature: "knowledge-search",
    promptVersion: "embed.v1",
    purpose: "query",
  });
  if (!q) return null;
  try {
    const rows = await KnowledgeChunkModel.aggregate([
      {
        $vectorSearch: {
          index: env.KNOWLEDGE_VECTOR_INDEX,
          path: "embedding",
          queryVector: q.vectors[0],
          numCandidates: Math.max(50, limit * 20),
          limit,
        },
      },
      { $project: { article: 1, title: 1, text: 1, score: { $meta: "vectorSearchScore" } } },
    ]);
    return rows.map((r: any) => ({
      articleId: String(r.article),
      title: r.title,
      text: r.text,
      score: Math.round(r.score * 1000) / 1000,
      method: "vector" as const,
    }));
  } catch (err) {
    // Local MongoDB or no Atlas index yet → text search
    logger.debug({ err: (err as Error).message }, "Vector search unavailable, using text search");
    return null;
  }
};

const textSearch = async (query: string, limit: number): Promise<Passage[]> => {
  const rows = await KnowledgeChunkModel.find({ $text: { $search: query } }, { score: { $meta: "textScore" } })
    .sort({ score: { $meta: "textScore" } })
    .limit(limit)
    .lean<any[]>()
    .catch(() => [] as any[]); // text index still building → keyword search below
  if (rows.length)
    return rows.map((r) => ({
      articleId: String(r.article),
      title: r.title,
      text: r.text,
      score: Math.round(r.score * 100) / 100,
      method: "text" as const,
    }));
  // Last resort: any meaningful word of the question appears in the chunk
  const words = query
    .split(/[\s,.?!।]+/)
    .filter((w) => w.length >= 3)
    .slice(0, 6);
  if (!words.length) return [];
  const regex = words.map((w) => ({ text: new RegExp(escapeRegex(w), "i") }));
  const hits = await KnowledgeChunkModel.find({ $or: regex }).limit(limit).lean<any[]>();
  return hits.map((r) => ({
    articleId: String(r.article),
    title: r.title,
    text: r.text,
    score: 0,
    method: "keyword" as const,
  }));
};

export const searchKnowledge = async (query: string, limit = 4): Promise<Passage[]> => {
  const vector = await vectorSearch(query, limit);
  if (vector?.length) return vector;
  return textSearch(query, limit);
};

/**
 * Create the Atlas Vector Search index once (Atlas only; harmless elsewhere). Run at start-up in the
 * background; if it cannot be created, retrieval keeps using text search.
 */
export const ensureVectorIndex = async () => {
  try {
    const existing = await KnowledgeChunkModel.listSearchIndexes().catch(() => []);
    if ((existing as any[]).some((i) => i.name === env.KNOWLEDGE_VECTOR_INDEX)) return "exists";
    await KnowledgeChunkModel.createSearchIndex({
      name: env.KNOWLEDGE_VECTOR_INDEX,
      type: "vectorSearch",
      definition: {
        fields: [
          { type: "vector", path: "embedding", numDimensions: env.AI_EMBEDDING_DIMENSIONS, similarity: "cosine" },
        ],
      },
    } as any);
    logger.info("Knowledge vector search index created");
    return "created";
  } catch (err) {
    logger.info({ reason: (err as Error).message }, "Knowledge vector index not available — text search will be used");
    return "unavailable";
  }
};

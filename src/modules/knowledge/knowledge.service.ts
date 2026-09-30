/* eslint-disable @typescript-eslint/no-explicit-any */
import { Request } from "express";
import { Types } from "mongoose";
import AppError from "../../errors/AppError";
import { buildPagination } from "../../interface/global.interface";
import { escapeRegex } from "../../utils/escapeRegex";
import { recordAudit } from "../audit/audit.service";
import {
  KnowledgeArticleDocument,
  KnowledgeArticleModel,
  KnowledgeCategory,
  KnowledgeChunkModel,
} from "./knowledge.model";
import { indexArticle, searchKnowledge } from "./retrieval";

export type ArticleInput = {
  titleEn?: string;
  titleBn?: string;
  category: KnowledgeCategory;
  contentEn?: string;
  contentBn?: string;
};

const toView = (a: any, withHistory = false) => ({
  id: String(a._id),
  titleEn: a.titleEn,
  titleBn: a.titleBn,
  category: a.category,
  contentEn: a.contentEn,
  contentBn: a.contentBn,
  languages: [a.contentBn?.trim() && "bn", a.contentEn?.trim() && "en"].filter(Boolean),
  status: a.status,
  version: a.version,
  publishedAt: a.publishedAt ?? null,
  indexedAt: a.indexedAt ?? null,
  indexMethod: a.indexMethod ?? null,
  updatedAt: a.updatedAt,
  ...(withHistory && {
    history: (a.history ?? [])
      .slice()
      .reverse()
      .map((h: any) => ({ version: h.version, titleEn: h.titleEn, titleBn: h.titleBn, status: h.status, at: h.at })),
  }),
});

const load = async (id: string) => {
  if (!Types.ObjectId.isValid(id)) throw new AppError(400, "Invalid article id.", "INVALID_ID");
  const a = (await KnowledgeArticleModel.findById(id)) as KnowledgeArticleDocument | null;
  if (!a) throw new AppError(404, "Article not found.");
  return a;
};

/** Keep the current text as a history entry before changing it */
const snapshot = (a: KnowledgeArticleDocument, userId: string) =>
  a.history.push({
    version: a.version,
    titleEn: a.titleEn,
    titleBn: a.titleBn,
    contentEn: a.contentEn,
    contentBn: a.contentBn,
    status: a.status,
    updatedBy: new Types.ObjectId(userId),
    at: new Date(),
  });

const assertContent = (a: { titleEn?: string; titleBn?: string; contentEn?: string; contentBn?: string }) => {
  if (!a.titleEn?.trim() && !a.titleBn?.trim())
    throw new AppError(400, "Give the article a title (Bangla or English).", "VALIDATION_ERROR");
  if (!a.contentEn?.trim() && !a.contentBn?.trim())
    throw new AppError(400, "Write the content in Bangla or English.", "VALIDATION_ERROR");
};

export const listArticles = async (f: {
  q?: string;
  status?: string;
  category?: string;
  page: number;
  limit: number;
}) => {
  const filter: Record<string, unknown> = {};
  if (f.status) filter.status = f.status;
  if (f.category) filter.category = f.category;
  if (f.q) {
    const rx = new RegExp(escapeRegex(f.q), "i");
    filter.$or = [{ titleEn: rx }, { titleBn: rx }, { contentEn: rx }, { contentBn: rx }];
  }
  const [items, total] = await Promise.all([
    KnowledgeArticleModel.find(filter)
      .select("-history")
      .sort({ updatedAt: -1 })
      .skip((f.page - 1) * f.limit)
      .limit(f.limit)
      .lean<any[]>(),
    KnowledgeArticleModel.countDocuments(filter),
  ]);
  return { items: items.map((a) => toView(a)), pagination: buildPagination(f.page, f.limit, total) };
};

export const getArticle = async (id: string) => toView(await load(id), true);

export const createArticle = async (req: Request, input: ArticleInput) => {
  assertContent(input);
  const a = await KnowledgeArticleModel.create({ ...input, status: "draft", createdBy: req.user!.id });
  await recordAudit({
    req,
    action: "CREATE",
    entityType: "KnowledgeArticle",
    entityId: a._id,
    after: { title: a.titleEn || a.titleBn },
  });
  return toView(a, true);
};

export const updateArticle = async (req: Request, id: string, input: Partial<ArticleInput>) => {
  const a = await load(id);
  snapshot(a, req.user!.id);
  a.set(input);
  assertContent(a);
  a.version += 1;
  a.updatedBy = new Types.ObjectId(req.user!.id);
  await a.save();
  if (a.status === "published") await indexArticle(a);
  await recordAudit({
    req,
    action: "UPDATE",
    entityType: "KnowledgeArticle",
    entityId: a._id,
    meta: { version: a.version },
  });
  return toView(await load(id), true);
};

export const setPublished = async (req: Request, id: string, published: boolean) => {
  const a = await load(id);
  if ((a.status === "published") === published) return toView(a, true);
  if (published) assertContent(a);
  snapshot(a, req.user!.id);
  a.status = published ? "published" : "draft";
  if (published) a.publishedAt = new Date();
  a.updatedBy = new Types.ObjectId(req.user!.id);
  await a.save();
  const indexed = await indexArticle(a);
  await recordAudit({
    req,
    action: "UPDATE",
    entityType: "KnowledgeArticle",
    entityId: a._id,
    after: { status: a.status },
    meta: { chunks: indexed.chunks, method: indexed.method },
  });
  return toView(await load(id), true);
};

export const deleteArticle = async (req: Request, id: string) => {
  const a = await load(id);
  await a.softDelete(req.user!.id);
  await KnowledgeChunkModel.deleteMany({ article: a._id });
  await recordAudit({
    req,
    action: "DELETE",
    entityType: "KnowledgeArticle",
    entityId: a._id,
    before: { title: a.titleEn || a.titleBn },
  });
};

/** Rebuild every published article's chunks + embeddings (after changing the embedding model) */
export const reindexAll = async (req: Request) => {
  const articles = (await KnowledgeArticleModel.find({ status: "published" })) as KnowledgeArticleDocument[];
  let chunks = 0;
  const methods = new Set<string>();
  for (const a of articles) {
    const r = await indexArticle(a);
    chunks += r.chunks;
    if (r.method) methods.add(r.method);
  }
  await recordAudit({
    req,
    action: "UPDATE",
    entityType: "KnowledgeBase",
    meta: { reindexed: articles.length, chunks },
  });
  return { articles: articles.length, chunks, methods: [...methods] };
};

export const retrievePassages = (question: string) => searchKnowledge(question, 5);

import mongoose, { HydratedDocument, Schema, Types } from "mongoose";
import { basePlugin, IBaseFields, IBaseMethods } from "../../models/plugins/basePlugin";

/**
 * KNOWLEDGE BASE — what the patient assistant may say about the hospital (policies, timings,
 * preparation, facilities, directions). Doctors, fees, schedules and slots are NOT written here:
 * they always come live from tools, so answers never go stale.
 *
 * An article is edited as a draft and published; every save keeps the previous version in
 * `history`. Publishing splits the text into chunks and embeds them for search.
 */
export const KNOWLEDGE_CATEGORIES = [
  "general",
  "departments",
  "doctors_schedules",
  "appointments",
  "tests_preparation",
  "payments",
  "facilities",
  "emergency",
  "directions",
] as const;
export type KnowledgeCategory = (typeof KNOWLEDGE_CATEGORIES)[number];

type Snapshot = {
  version: number;
  titleEn: string;
  titleBn: string;
  contentEn: string;
  contentBn: string;
  status: "draft" | "published";
  updatedBy?: Types.ObjectId | null;
  at: Date;
};

export interface IKnowledgeArticle extends IBaseFields {
  titleEn: string;
  titleBn: string;
  category: KnowledgeCategory;
  contentEn: string; // markdown
  contentBn: string; // markdown
  status: "draft" | "published";
  version: number;
  publishedAt?: Date | null;
  indexedAt?: Date | null; // when chunks/embeddings were last rebuilt
  indexMethod?: "vector" | "text" | null;
  history: Snapshot[];
}

export type KnowledgeArticleDocument = HydratedDocument<IKnowledgeArticle, IBaseMethods>;

const ArticleSchema = new Schema<IKnowledgeArticle>({
  titleEn: { type: String, trim: true, maxlength: 200, default: "" },
  titleBn: { type: String, trim: true, maxlength: 200, default: "" },
  category: { type: String, enum: KNOWLEDGE_CATEGORIES, required: true },
  contentEn: { type: String, maxlength: 20000, default: "" },
  contentBn: { type: String, maxlength: 20000, default: "" },
  status: { type: String, enum: ["draft", "published"], default: "draft" },
  version: { type: Number, default: 1 },
  publishedAt: { type: Date, default: null },
  indexedAt: { type: Date, default: null },
  indexMethod: { type: String, enum: ["vector", "text", null], default: null },
  history: {
    type: [
      new Schema<Snapshot>(
        {
          version: Number,
          titleEn: String,
          titleBn: String,
          contentEn: String,
          contentBn: String,
          status: String,
          updatedBy: { type: Schema.Types.ObjectId, ref: "User", default: null },
          at: Date,
        },
        { _id: false },
      ),
    ],
    default: [],
  },
});
ArticleSchema.index({ status: 1, category: 1 });
ArticleSchema.plugin(basePlugin);

export const KnowledgeArticleModel =
  mongoose.models.KnowledgeArticle ||
  mongoose.model<IKnowledgeArticle, mongoose.Model<IKnowledgeArticle, object, IBaseMethods>>(
    "KnowledgeArticle",
    ArticleSchema,
  );

// ------------------------------------------------------------------ chunks (search units)

export interface IKnowledgeChunk {
  article: Types.ObjectId;
  articleVersion: number;
  language: "bn" | "en";
  title: string;
  text: string;
  embedding?: number[]; // absent when embeddings are unavailable (text search still works)
  embeddingModel?: string | null;
}

const ChunkSchema = new Schema<IKnowledgeChunk>(
  {
    article: { type: Schema.Types.ObjectId, ref: "KnowledgeArticle", required: true, index: true },
    articleVersion: { type: Number, required: true },
    language: { type: String, enum: ["bn", "en"], required: true },
    title: { type: String, default: "" },
    text: { type: String, required: true },
    embedding: { type: [Number], default: undefined, select: false },
    embeddingModel: { type: String, default: null },
  },
  { timestamps: true },
);
// Fallback search. language "none": no English stemming, so Bangla words are matched as written.
// language_override points at a field that does not exist, because our own "language" field ("bn")
// would otherwise be read by MongoDB as the text-search language (and "bn" is not supported).
ChunkSchema.index(
  { title: "text", text: "text" },
  { default_language: "none", language_override: "textSearchLanguage", weights: { title: 3, text: 1 } },
);

export const KnowledgeChunkModel =
  mongoose.models.KnowledgeChunk || mongoose.model<IKnowledgeChunk>("KnowledgeChunk", ChunkSchema);

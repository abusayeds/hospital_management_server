import { z } from "zod";
import { searchKnowledge } from "../../knowledge/retrieval";
import { defineTool } from "./types";

export const searchKnowledgeBase = defineTool({
  name: "search_knowledge_base",
  description:
    "Search the hospital's published information (visiting hours, how to book or cancel, fees rules, payments, " +
    "test preparation, report delivery, facilities, parking, ambulance, directions). Answer ONLY from the passages.",
  parameters: {
    type: "object",
    properties: { query: { type: "string", description: "The patient's question in their own words" } },
    required: ["query"],
  },
  schema: z.object({ query: z.string().trim().min(2).max(300) }),
  run: async ({ query }) => {
    const passages = await searchKnowledge(query, 4);
    return {
      summary: `${passages.length} passages (${passages[0]?.method ?? "none"})`,
      data: passages.length
        ? passages.map((p) => ({ source: p.title, text: p.text.slice(0, 900) }))
        : { found: 0, note: "Not in the knowledge base. Say you don't know and offer a staff member." },
    };
  },
});

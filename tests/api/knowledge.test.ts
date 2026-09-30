import { setAiProvider } from "../../src/ai/ai.service";
import { seedKnowledge } from "../../src/DB/seed-data/knowledge";
import { KnowledgeChunkModel } from "../../src/modules/knowledge/knowledge.model";
import { chunkText, searchKnowledge } from "../../src/modules/knowledge/retrieval";
import { scriptedProvider } from "../assistant-fakes";
import { createUser, signIn, useTestDatabase } from "../helpers";

describe("Knowledge base", () => {
  useTestDatabase();
  afterEach(() => setAiProvider(undefined));

  it("chunks long text into overlapping windows", () => {
    const words = Array.from({ length: 400 }, (_, i) => `w${i}`).join(" ");
    const chunks = chunkText(words);
    expect(chunks.length).toBe(3);
    expect(chunks[1].startsWith("w140")).toBe(true); // 180-word windows, 40-word overlap
  });

  it("without embeddings, search falls back to text search in English and Bangla", async () => {
    setAiProvider(null);
    await seedKnowledge();
    const en = await searchKnowledge("fasting before lipid profile");
    expect(en[0]).toMatchObject({ method: "text" });
    expect(en.map((p) => p.title)).toContain("Lipid profile preparation");
    const bn = await searchKnowledge("ভর্তি রোগী দেখার সময়");
    expect(bn.map((p) => p.title)).toContain("ভর্তি রোগী দেখার সময়");
  });

  it("admin: drafts are not searchable, publishing indexes, edits keep versions, unpublishing removes", async () => {
    setAiProvider(null);
    await createUser({ role: "super_admin", email: "admin@test.local" });
    const admin = await signIn("admin@test.local");

    const created = await admin.post("/api/v1/knowledge/articles").send({
      category: "facilities",
      titleEn: "Wi-Fi",
      contentEn: "Free wifi is available in the waiting area. Network name Testolife-Guest.",
    });
    expect(created.status).toBe(201);
    const id = created.body.data.id;
    expect(await searchKnowledge("wifi network")).toHaveLength(0);

    await admin.post(`/api/v1/knowledge/articles/${id}/publish`);
    expect((await searchKnowledge("wifi network"))[0].title).toBe("Wi-Fi");

    const edited = await admin
      .patch(`/api/v1/knowledge/articles/${id}`)
      .send({ contentEn: "Free wifi in the waiting area and canteen. Network name Testolife-Guest." });
    expect(edited.body.data).toMatchObject({ version: 2 });
    expect(edited.body.data.history.length).toBeGreaterThanOrEqual(2);
    expect((await KnowledgeChunkModel.findOne({ article: id }))?.text).toContain("canteen");

    await admin.post(`/api/v1/knowledge/articles/${id}/unpublish`);
    expect(await searchKnowledge("wifi network")).toHaveLength(0);
  });

  it("only knowledge:manage can edit (reception gets 403)", async () => {
    await createUser({ role: "reception", email: "rec@test.local" });
    const rec = await signIn("rec@test.local");
    expect((await rec.get("/api/v1/knowledge/articles")).status).toBe(403);
  });

  it("'test the assistant' shows retrieved passages and the answer, without storing a conversation", async () => {
    await seedKnowledge();
    setAiProvider(
      scriptedProvider([
        () => ({ toolCalls: [{ name: "search_knowledge_base", args: { query: "visiting hours" } }] }),
        () => ({ text: "Visiting hours are 11 AM–1 PM and 5–7 PM." }),
      ]).provider,
    );
    await createUser({ role: "super_admin", email: "admin@test.local" });
    const admin = await signIn("admin@test.local");
    const res = await admin.post("/api/v1/knowledge/test").send({ question: "visiting hours for admitted patients" });
    expect(res.status).toBe(200);
    expect(res.body.data.passages[0].title).toBe("Visiting hours for admitted patients");
    expect(res.body.data.answer.messages[0].text).toContain("11 AM");
    expect(res.body.data.answer.toolCalls[0]).toMatchObject({ name: "search_knowledge_base", success: true });
  });
});

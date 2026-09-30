import { stripDangerousKeys } from "../../src/middlewares/sanitize";

describe("stripDangerousKeys", () => {
  it("removes MongoDB operators at any depth", () => {
    const body = { phone: { $gt: "" }, filters: [{ name: { $regex: ".*" } }], ok: 1 };
    const removed = stripDangerousKeys(body, "body");
    expect(body).toEqual({ phone: {}, filters: [{ name: {} }], ok: 1 });
    expect(removed).toEqual(["body.phone.$gt", "body.filters[0].name.$regex"]);
  });

  it("removes dotted keys and prototype pollution keys", () => {
    const body = JSON.parse('{"profile.role":"admin","__proto__":{"isAdmin":true},"name":"Rahim"}');
    stripDangerousKeys(body);
    expect(Object.keys(body)).toEqual(["name"]);
    expect(({} as Record<string, unknown>).isAdmin).toBeUndefined();
  });

  it("leaves normal input untouched", () => {
    const body = { name: "রহিম উদ্দিন", age: 42, tags: ["fever", "cough"] };
    expect(stripDangerousKeys(body)).toEqual([]);
    expect(body).toEqual({ name: "রহিম উদ্দিন", age: 42, tags: ["fever", "cough"] });
  });
});

import { app, request } from "../helpers";

// Every kind of failure leaves the API in the same { error: { code, message, details } } shape.
// None of these reach the database, so no test DB is needed here.
describe("API error format", () => {
  it("unknown route → 404 NOT_FOUND", async () => {
    const res = await request(app).get("/api/v1/does-not-exist");
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe("NOT_FOUND");
  });

  it("$gt injection is stripped and then rejected by validation → 400", async () => {
    const res = await request(app)
      .post("/api/v1/chat/message")
      .send({ message: { $gt: "" } });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("VALIDATION_ERROR");
    expect(res.body.error.details[0].path).toBe("body.message");
  });

  it("malformed JSON → 400 INVALID_JSON", async () => {
    const res = await request(app)
      .post("/api/v1/chat/message")
      .set("Content-Type", "application/json")
      .send("{ not json");
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("INVALID_JSON");
  });

  it("protected route without a session → 401", async () => {
    const res = await request(app).get("/api/v1/users");
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe("UNAUTHORIZED");
  });

  it("cross-site state-changing request → 403 CSRF_REJECTED", async () => {
    const res = await request(app).post("/api/v1/auth/login").set("Origin", "https://evil.example").send({});
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe("CSRF_REJECTED");
  });

  it("sets security headers", async () => {
    const res = await request(app).get("/api/v1/does-not-exist");
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
    expect(res.headers["x-powered-by"]).toBeUndefined();
  });
});

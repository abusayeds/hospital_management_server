import { formatCode } from "../../src/models/counter.model";

describe("formatCode", () => {
  it("pads the number to a fixed width", () => {
    expect(formatCode("TL", 123)).toBe("TL-000123");
    expect(formatCode("INV", 7, 5)).toBe("INV-00007");
  });

  it("does not truncate numbers wider than the padding", () => {
    expect(formatCode("TL", 1234567)).toBe("TL-1234567");
  });
});

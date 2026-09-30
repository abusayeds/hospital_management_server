import {
  allergyMatches,
  buildInstructions,
  computeBmi,
  describeDose,
  duplicateGenerics,
  flagLabValue,
  flagVitals,
  worstLevel,
} from "../../src/shared/clinical-rules";

describe("vital flags", () => {
  it("normal vitals give no flags", () => {
    const flags = flagVitals({
      bpSystolic: 120,
      bpDiastolic: 80,
      pulse: 76,
      temperatureF: 98.4,
      respiratoryRate: 16,
      spo2: 98,
    });
    expect(flags).toEqual([]);
    expect(worstLevel(flags)).toBe("normal");
  });

  it("uses the agreed thresholds: BP ≥ 140/90 high, SpO2 < 94 low, temperature ≥ 100.4 fever", () => {
    const keys = (v: Parameters<typeof flagVitals>[0]) => flagVitals(v).map((f) => `${f.key}:${f.level}`);
    expect(keys({ bpSystolic: 140, bpDiastolic: 80 })).toEqual(["bp:abnormal"]);
    expect(keys({ bpSystolic: 130, bpDiastolic: 90 })).toEqual(["bp:abnormal"]);
    expect(keys({ bpSystolic: 139, bpDiastolic: 89 })).toEqual([]);
    expect(keys({ spo2: 93 })).toEqual(["spo2:abnormal"]);
    expect(keys({ spo2: 94 })).toEqual([]);
    expect(keys({ temperatureF: 100.4 })).toEqual(["temperatureF:abnormal"]);
    expect(keys({ temperatureF: 100.3 })).toEqual([]);
  });

  it("marks dangerous values as critical", () => {
    expect(worstLevel(flagVitals({ bpSystolic: 190, bpDiastolic: 110 }))).toBe("critical");
    expect(worstLevel(flagVitals({ spo2: 86 }))).toBe("critical");
    expect(worstLevel(flagVitals({ bloodSugar: { value: 2.5, type: "random" } }))).toBe("critical");
  });

  it("judges blood sugar by fasting or random", () => {
    expect(flagVitals({ bloodSugar: { value: 8, type: "fasting" } })[0]?.label).toBe("Sugar high");
    expect(flagVitals({ bloodSugar: { value: 8, type: "random" } })).toEqual([]);
  });

  it("calculates BMI and flags it with Asian cut-offs", () => {
    expect(computeBmi(70, 170)).toBe(24.2);
    expect(computeBmi(70, null)).toBeNull();
    expect(flagVitals({ weightKg: 70, heightCm: 170 }).map((f) => f.label)).toEqual(["Overweight"]);
  });
});

describe("lab result flags", () => {
  const hb = { normalMin: 12, normalMax: 16 };
  it("low / normal / high / critical from the catalogue range", () => {
    expect(flagLabValue("13.5", hb)).toBe("normal");
    expect(flagLabValue(10, hb)).toBe("low");
    expect(flagLabValue(17, hb)).toBe("high");
    expect(flagLabValue(5, hb)).toBe("critical");
    expect(flagLabValue(40, hb)).toBe("critical");
  });
  it("text results compare case-insensitively; empty values are not flagged", () => {
    expect(flagLabValue("negative", { normalText: "Negative" })).toBe("normal");
    expect(flagLabValue("Positive", { normalText: "Negative" })).toBe("abnormal");
    expect(flagLabValue("", hb)).toBeNull();
  });
});

describe("dose pattern helper", () => {
  it("turns 1+0+1 into Bangla and English", () => {
    expect(describeDose("1+0+1")).toEqual({ en: "1 in the morning, 1 at night", bn: "সকালে ১টা, রাতে ১টা" });
    expect(describeDose("0+0+1")).toEqual({ en: "1 at night", bn: "রাতে ১টা" });
    expect(describeDose("½+0+½")?.bn).toBe("সকালে আধা, রাতে আধা");
    expect(describeDose("abc")).toBeNull();
  });
  it("builds the full instruction line", () => {
    expect(buildInstructions({ dosePattern: "1+1+1", timing: "after_meal", durationDays: 7 }).bn).toBe(
      "সকালে ১টা, দুপুরে ১টা, রাতে ১টা — খাবারের পরে — ৭ দিন",
    );
    expect(buildInstructions({ dosePattern: "1+0+0", timing: "before_meal", durationDays: "continue" }).en).toBe(
      "1 in the morning — before meal — continue",
    );
  });
});

describe("prescription safety checks", () => {
  it("matches allergies by name and by drug family", () => {
    expect(allergyMatches(["Penicillin"], { brandName: "Moxacil", genericName: "Amoxicillin" })).toEqual([
      "Penicillin",
    ]);
    expect(allergyMatches(["Sulfa drugs"], { brandName: "Cotrim", genericName: "Co-trimoxazole" })).toEqual([
      "Sulfa drugs",
    ]);
    expect(allergyMatches(["NSAID"], { brandName: "Napa", genericName: "Paracetamol" })).toEqual([]);
    expect(allergyMatches(["Ibuprofen"], { brandName: "Profen", genericName: "Ibuprofen" })).toEqual(["Ibuprofen"]);
  });
  it("finds the same generic prescribed twice", () => {
    expect(
      duplicateGenerics([{ genericName: "Paracetamol" }, { genericName: "paracetamol " }, { genericName: "" }]),
    ).toEqual(["paracetamol"]);
  });
});

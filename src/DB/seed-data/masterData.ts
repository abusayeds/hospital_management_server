// DEMO DATA ONLY — fictional doctors; catalogs are common, public reference items.
// Money is in POISHA (৳700 = 70000). Days: 0 Sun … 4 Thu, 5 Fri (off), 6 Sat.

const T = (taka: number) => taka * 100;
const WORKDAYS = [6, 0, 1, 2, 3, 4]; // Saturday–Thursday
const ALT_A = [6, 1, 3]; // Sat, Mon, Wed
const ALT_B = [0, 2, 4]; // Sun, Tue, Thu

const sessions = (days: number[], startTime: string, endTime: string, slotMinutes = 10, maxPatients = 20) =>
  days.map((dayOfWeek) => ({ dayOfWeek, startTime, endTime, slotMinutes, maxPatients }));

export const DEPARTMENTS = [
  {
    name: "Medicine",
    nameBn: "মেডিসিন",
    icon: "stethoscope",
    displayOrder: 1,
    description: "Fever, diabetes, blood pressure and general illness",
  },
  {
    name: "Cardiology",
    nameBn: "হৃদরোগ",
    icon: "heart-pulse",
    displayOrder: 2,
    description: "Heart disease, chest pain follow-up, ECG and echo",
  },
  {
    name: "Gynecology & Obstetrics",
    nameBn: "গাইনি ও প্রসূতি",
    icon: "baby",
    displayOrder: 3,
    description: "Women's health and pregnancy care",
  },
  {
    name: "Pediatrics",
    nameBn: "শিশু",
    icon: "smile",
    displayOrder: 4,
    description: "Children's health, growth and vaccination advice",
  },
  {
    name: "Orthopedics",
    nameBn: "হাড় ও জোড়া",
    icon: "bone",
    displayOrder: 5,
    description: "Bone, joint, back pain and fracture follow-up",
  },
  { name: "ENT", nameBn: "নাক কান গলা", icon: "ear", displayOrder: 6, description: "Ear, nose and throat problems" },
  { name: "Dermatology", nameBn: "চর্ম ও যৌন", icon: "hand", displayOrder: 7, description: "Skin, hair and allergy" },
  {
    name: "Neurology",
    nameBn: "স্নায়ুরোগ",
    icon: "brain",
    displayOrder: 8,
    description: "Headache, stroke follow-up, epilepsy and nerve problems",
  },
];

export const DOCTORS = [
  {
    name: "Farhana Rahman",
    nameBn: "ফারহানা রহমান",
    title: "Dr.",
    dept: "Medicine",
    degrees: "MBBS, FCPS (Medicine)",
    specialization: "Diabetes & Hypertension",
    fee: 700,
    room: "101",
    sessions: [...sessions(WORKDAYS, "09:00", "13:00", 10, 22)],
  },
  {
    name: "Tanvir Ahmed",
    nameBn: "তানভীর আহমেদ",
    title: "Dr.",
    dept: "Medicine",
    degrees: "MBBS, MD (Internal Medicine)",
    specialization: "General Medicine",
    fee: 600,
    room: "102",
    sessions: [...sessions(ALT_A, "17:00", "21:00", 10, 24), ...sessions(ALT_B, "10:00", "13:00", 10, 18)],
  },
  {
    name: "Mahbub Hasan",
    nameBn: "মাহবুব হাসান",
    title: "Prof. Dr.",
    dept: "Cardiology",
    degrees: "MBBS, MD (Cardiology), FACC",
    specialization: "Interventional Cardiology",
    fee: 1500,
    room: "201",
    sessions: sessions(ALT_B, "16:00", "20:00", 15, 16),
  },
  {
    name: "Shahnaz Parvin",
    nameBn: "শাহনাজ পারভীন",
    title: "Dr.",
    dept: "Cardiology",
    degrees: "MBBS, FCPS (Medicine), MD (Cardiology)",
    specialization: "Heart Failure & Hypertension",
    fee: 1000,
    room: "202",
    sessions: sessions(ALT_A, "10:00", "13:00", 15, 12),
  },
  {
    name: "Nusrat Jahan",
    nameBn: "নুসরাত জাহান",
    title: "Dr.",
    dept: "Gynecology & Obstetrics",
    degrees: "MBBS, FCPS (Gynae & Obs)",
    specialization: "Pregnancy Care & Infertility",
    fee: 800,
    room: "301",
    sessions: [...sessions(ALT_A, "11:00", "14:00", 10, 18), ...sessions(ALT_B, "17:00", "20:00", 10, 18)],
  },
  {
    name: "Arif Hossain",
    nameBn: "আরিফ হোসেন",
    title: "Dr.",
    dept: "Pediatrics",
    degrees: "MBBS, DCH, MD (Pediatrics)",
    specialization: "Child Health & Nutrition",
    fee: 700,
    room: "103",
    sessions: [...sessions(WORKDAYS, "09:30", "12:30", 10, 18), ...sessions([1, 3], "18:00", "20:00", 10, 12)],
  },
  {
    name: "Kamrul Islam",
    nameBn: "কামরুল ইসলাম",
    title: "Assoc. Prof. Dr.",
    dept: "Orthopedics",
    degrees: "MBBS, MS (Orthopedics)",
    specialization: "Joint Replacement & Spine",
    fee: 1200,
    room: "203",
    sessions: sessions(ALT_B, "17:00", "21:00", 15, 16),
  },
  {
    name: "Rashida Begum",
    nameBn: "রাশিদা বেগম",
    title: "Dr.",
    dept: "Orthopedics",
    degrees: "MBBS, D-Ortho",
    specialization: "Sports Injury & Fracture Care",
    fee: 800,
    room: "204",
    sessions: sessions(ALT_A, "10:00", "13:00", 10, 18),
  },
  {
    name: "Sadia Akter",
    nameBn: "সাদিয়া আক্তার",
    title: "Dr.",
    dept: "ENT",
    degrees: "MBBS, DLO, FCPS (ENT)",
    specialization: "Ear, Nose & Throat",
    fee: 600,
    room: "104",
    sessions: [...sessions(ALT_A, "15:00", "18:00", 10, 18), ...sessions(ALT_B, "09:00", "12:00", 10, 18)],
  },
  {
    name: "Rezaul Karim",
    nameBn: "রেজাউল করিম",
    title: "Dr.",
    dept: "Dermatology",
    degrees: "MBBS, DDV, FCPS (Dermatology)",
    specialization: "Skin, Hair & Allergy",
    fee: 600,
    room: "105",
    sessions: sessions(WORKDAYS, "16:00", "19:00", 10, 18),
  },
  {
    name: "Imran Chowdhury",
    nameBn: "ইমরান চৌধুরী",
    title: "Dr.",
    dept: "Neurology",
    degrees: "MBBS, MD (Neurology)",
    specialization: "Headache, Epilepsy & Stroke",
    fee: 1000,
    room: "205",
    sessions: sessions(ALT_B, "10:00", "13:00", 15, 12),
  },
  {
    name: "Selina Hossain",
    nameBn: "সেলিনা হোসেন",
    title: "Dr.",
    dept: "Medicine",
    degrees: "MBBS, MRCP (UK)",
    specialization: "Thyroid & Endocrine",
    fee: 900,
    room: "106",
    sessions: sessions([6, 0, 2], "18:00", "21:00", 10, 18),
  },
].map(({ fee, room, dept, ...d }) => ({
  ...d,
  dept,
  roomNo: room,
  consultationFee: T(fee),
  followUpFee: T(Math.round(fee / 2 / 50) * 50), // follow-up: about half, rounded to ৳50
  followUpValidDays: 30,
  maxPatientsPerSession: 20,
  averageMinutesPerPatient: 10,
  languages: ["Bangla", "English"],
}));

// The demo doctor login (doctor@testolife.test) is linked to this profile
export const DEMO_DOCTOR_PROFILE = "Farhana Rahman";

export const SERVICES = [
  { name: "Consultation (new patient)", nameBn: "কনসালটেশন (নতুন)", category: "consultation", price: T(700) },
  { name: "Consultation (follow-up)", nameBn: "কনসালটেশন (ফলো-আপ)", category: "consultation", price: T(350) },
  { name: "Emergency consultation", nameBn: "জরুরি কনসালটেশন", category: "consultation", price: T(500) },
  { name: "Dressing (small)", nameBn: "ড্রেসিং (ছোট)", category: "procedure", price: T(300) },
  { name: "Dressing (large)", nameBn: "ড্রেসিং (বড়)", category: "procedure", price: T(600) },
  { name: "Nebulization", nameBn: "নেবুলাইজেশন", category: "procedure", price: T(250) },
  { name: "Injection push (IM/IV)", nameBn: "ইনজেকশন পুশ", category: "procedure", price: T(100) },
  { name: "IV cannulation", nameBn: "ক্যানুলা করা", category: "procedure", price: T(300) },
  { name: "Suture removal", nameBn: "সেলাই কাটা", category: "procedure", price: T(300) },
  { name: "Ear wax removal", nameBn: "কানের ময়লা পরিষ্কার", category: "procedure", price: T(500) },
  { name: "Plaster (POP) application", nameBn: "প্লাস্টার", category: "procedure", price: T(1500) },
  { name: "Medical certificate", nameBn: "মেডিকেল সার্টিফিকেট", category: "other", price: T(200) },
];

type P = { name: string; unit?: string; normalMin?: number; normalMax?: number; normalText?: string };
const lab = (
  code: string,
  name: string,
  category: string,
  price: number,
  sampleType: string,
  turnaroundHours: number,
  parameters: P[],
  preparationNote?: string,
  preparationNoteBn?: string,
) => ({
  code,
  name,
  category,
  price: T(price),
  sampleType,
  turnaroundHours,
  parameters,
  preparationNote,
  preparationNoteBn,
});
const FASTING = ["Fasting 8–10 hours (water allowed)", "৮–১০ ঘণ্টা খালি পেটে আসুন (পানি খাওয়া যাবে)"] as const;

export const LAB_TESTS = [
  lab("CBC", "Complete Blood Count (CBC)", "Hematology", 400, "Blood (EDTA)", 6, [
    { name: "Hemoglobin", unit: "g/dL", normalMin: 12, normalMax: 16 },
    { name: "Total WBC count", unit: "/cmm", normalMin: 4000, normalMax: 11000 },
    { name: "Neutrophils", unit: "%", normalMin: 40, normalMax: 75 },
    { name: "Lymphocytes", unit: "%", normalMin: 20, normalMax: 45 },
    { name: "Platelet count", unit: "/cmm", normalMin: 150000, normalMax: 450000 },
    { name: "ESR", unit: "mm/1st hr", normalMin: 0, normalMax: 20 },
  ]),
  lab("ESR", "Erythrocyte Sedimentation Rate", "Hematology", 150, "Blood (EDTA)", 4, [
    { name: "ESR", unit: "mm/1st hr", normalMin: 0, normalMax: 20 },
  ]),
  lab("BG-RH", "Blood Grouping & Rh Typing", "Hematology", 200, "Blood (EDTA)", 2, [
    { name: "Blood group", normalText: "A/B/AB/O" },
    { name: "Rh factor", normalText: "Positive/Negative" },
  ]),
  lab("RBS", "Random Blood Sugar", "Biochemistry", 150, "Blood (fluoride)", 2, [
    { name: "Glucose (random)", unit: "mmol/L", normalMin: 3.9, normalMax: 7.8 },
  ]),
  lab(
    "FBS",
    "Fasting Blood Sugar",
    "Biochemistry",
    150,
    "Blood (fluoride)",
    2,
    [{ name: "Glucose (fasting)", unit: "mmol/L", normalMin: 3.9, normalMax: 6.1 }],
    ...FASTING,
  ),
  lab(
    "2HABF",
    "Blood Sugar 2 Hours After Breakfast",
    "Biochemistry",
    150,
    "Blood (fluoride)",
    2,
    [{ name: "Glucose (2h ABF)", unit: "mmol/L", normalMin: 3.9, normalMax: 7.8 }],
    "Come exactly 2 hours after breakfast",
    "নাস্তার ঠিক ২ ঘণ্টা পর আসুন",
  ),
  lab("HBA1C", "HbA1c (Glycated Hemoglobin)", "Biochemistry", 1000, "Blood (EDTA)", 24, [
    { name: "HbA1c", unit: "%", normalMin: 4, normalMax: 5.6 },
  ]),
  lab(
    "LIPID",
    "Lipid Profile",
    "Biochemistry",
    1000,
    "Blood (clotted)",
    12,
    [
      { name: "Total cholesterol", unit: "mg/dL", normalMin: 0, normalMax: 200 },
      { name: "Triglycerides", unit: "mg/dL", normalMin: 0, normalMax: 150 },
      { name: "HDL cholesterol", unit: "mg/dL", normalMin: 40, normalMax: 100 },
      { name: "LDL cholesterol", unit: "mg/dL", normalMin: 0, normalMax: 130 },
    ],
    "Fasting 10–12 hours",
    "১০–১২ ঘণ্টা খালি পেটে আসুন",
  ),
  lab("CREAT", "Serum Creatinine", "Biochemistry", 400, "Blood (clotted)", 6, [
    { name: "Creatinine", unit: "mg/dL", normalMin: 0.6, normalMax: 1.3 },
  ]),
  lab("UREA", "Blood Urea", "Biochemistry", 400, "Blood (clotted)", 6, [
    { name: "Urea", unit: "mg/dL", normalMin: 15, normalMax: 40 },
  ]),
  lab("SGPT", "SGPT (ALT)", "Biochemistry", 400, "Blood (clotted)", 6, [
    { name: "ALT", unit: "U/L", normalMin: 0, normalMax: 40 },
  ]),
  lab("SGOT", "SGOT (AST)", "Biochemistry", 400, "Blood (clotted)", 6, [
    { name: "AST", unit: "U/L", normalMin: 0, normalMax: 40 },
  ]),
  lab("BILI", "Serum Bilirubin (Total)", "Biochemistry", 350, "Blood (clotted)", 6, [
    { name: "Total bilirubin", unit: "mg/dL", normalMin: 0.2, normalMax: 1.2 },
  ]),
  lab("URIC", "Serum Uric Acid", "Biochemistry", 450, "Blood (clotted)", 6, [
    { name: "Uric acid", unit: "mg/dL", normalMin: 3.5, normalMax: 7.2 },
  ]),
  lab("ELECT", "Serum Electrolytes", "Biochemistry", 900, "Blood (clotted)", 8, [
    { name: "Sodium", unit: "mmol/L", normalMin: 135, normalMax: 145 },
    { name: "Potassium", unit: "mmol/L", normalMin: 3.5, normalMax: 5.1 },
    { name: "Chloride", unit: "mmol/L", normalMin: 98, normalMax: 107 },
  ]),
  lab("TSH", "Thyroid Stimulating Hormone (TSH)", "Hormone", 900, "Blood (clotted)", 24, [
    { name: "TSH", unit: "µIU/mL", normalMin: 0.4, normalMax: 4.5 },
  ]),
  lab("FT4", "Free T4", "Hormone", 900, "Blood (clotted)", 24, [
    { name: "Free T4", unit: "ng/dL", normalMin: 0.8, normalMax: 1.8 },
  ]),
  lab("VITD", "Vitamin D (25-OH)", "Hormone", 2500, "Blood (clotted)", 48, [
    { name: "25-OH Vitamin D", unit: "ng/mL", normalMin: 30, normalMax: 100 },
  ]),
  lab("CRP", "C-Reactive Protein", "Immunology", 700, "Blood (clotted)", 6, [
    { name: "CRP", unit: "mg/L", normalMin: 0, normalMax: 6 },
  ]),
  lab("WIDAL", "Widal Test", "Immunology", 350, "Blood (clotted)", 6, [
    { name: "S. Typhi O", normalText: "< 1:80" },
    { name: "S. Typhi H", normalText: "< 1:160" },
  ]),
  lab("DENGUE", "Dengue NS1 Antigen", "Immunology", 500, "Blood (clotted)", 4, [
    { name: "NS1 antigen", normalText: "Negative" },
  ]),
  lab("HBSAG", "HBsAg (Hepatitis B)", "Immunology", 500, "Blood (clotted)", 6, [
    { name: "HBsAg", normalText: "Negative" },
  ]),
  lab(
    "URE",
    "Urine Routine Examination (R/E)",
    "Clinical Pathology",
    250,
    "Urine (midstream)",
    4,
    [
      { name: "Colour", normalText: "Straw" },
      { name: "Protein", normalText: "Nil" },
      { name: "Sugar", normalText: "Nil" },
      { name: "Pus cells", unit: "/HPF", normalMin: 0, normalMax: 5 },
      { name: "RBC", unit: "/HPF", normalMin: 0, normalMax: 2 },
    ],
    "First morning urine, midstream, in a clean container",
    "সকালের প্রথম প্রস্রাব, মাঝের অংশ, পরিষ্কার পাত্রে",
  ),
  lab("STOOL", "Stool Routine Examination", "Clinical Pathology", 250, "Stool", 6, [
    { name: "Ova/cyst", normalText: "Not found" },
    { name: "Occult blood", normalText: "Negative" },
  ]),
  lab(
    "XRAY-CH",
    "X-Ray Chest (P/A view)",
    "Radiology",
    600,
    "Imaging",
    4,
    [{ name: "Impression", normalText: "Normal study" }],
    "Remove metal objects and jewellery",
    "গয়না ও ধাতব জিনিস খুলে আসুন",
  ),
  lab("ECG", "ECG (12 lead)", "Cardiac", 400, "Procedure", 1, [
    { name: "Impression", normalText: "Normal sinus rhythm" },
  ]),
  lab("ECHO", "Echocardiography (2D)", "Cardiac", 2500, "Imaging", 24, [
    { name: "Ejection fraction", unit: "%", normalMin: 55, normalMax: 70 },
  ]),
  lab(
    "USG-WA",
    "USG of Whole Abdomen",
    "Radiology",
    1800,
    "Imaging",
    6,
    [{ name: "Impression", normalText: "Normal study" }],
    "Fasting 6 hours and a full bladder (drink water 1 hour before)",
    "৬ ঘণ্টা খালি পেটে; ১ ঘণ্টা আগে পানি খেয়ে মূত্রথলি ভরা রাখুন",
  ),
];

type Form =
  | "tablet"
  | "capsule"
  | "syrup"
  | "suspension"
  | "injection"
  | "drops"
  | "cream"
  | "ointment"
  | "inhaler"
  | "suppository"
  | "powder"
  | "gel";
const med = (brandName: string, genericName: string, strength: string, form: Form, manufacturer: string) => ({
  brandName,
  genericName,
  strength,
  form,
  manufacturer,
});

export const MEDICINES = [
  med("Napa", "Paracetamol", "500 mg", "tablet", "Beximco"),
  med("Napa Extra", "Paracetamol + Caffeine", "500 mg + 65 mg", "tablet", "Beximco"),
  med("Napa", "Paracetamol", "120 mg/5 ml", "syrup", "Beximco"),
  med("Ace", "Paracetamol", "500 mg", "tablet", "Square"),
  med("Ace Plus", "Paracetamol + Caffeine", "500 mg + 65 mg", "tablet", "Square"),
  med("Tufnil", "Tolfenamic acid", "200 mg", "tablet", "Eskayef"),
  med("Naprosyn", "Naproxen", "500 mg", "tablet", "Radiant"),
  med("Rolac", "Ketorolac", "10 mg", "tablet", "Renata"),
  med("Seclo", "Omeprazole", "20 mg", "capsule", "Square"),
  med("Losectil", "Omeprazole", "20 mg", "capsule", "Eskayef"),
  med("Sergel", "Esomeprazole", "20 mg", "capsule", "Healthcare"),
  med("Maxpro", "Esomeprazole", "20 mg", "tablet", "Renata"),
  med("Pantonix", "Pantoprazole", "20 mg", "tablet", "Incepta"),
  med("Finix", "Rabeprazole", "20 mg", "tablet", "Opsonin"),
  med("Antacid Plus", "Aluminium hydroxide + Magnesium hydroxide", "200 mg + 400 mg/5 ml", "suspension", "Square"),
  med("Motigut", "Domperidone", "10 mg", "tablet", "Eskayef"),
  med("Emistat", "Ondansetron", "8 mg", "tablet", "Incepta"),
  med("Flagyl", "Metronidazole", "400 mg", "tablet", "Sanofi"),
  med("Amodis", "Metronidazole", "400 mg", "tablet", "Square"),
  med("Orsaline-N", "Oral rehydration salts", "10.25 g", "powder", "SMC"),
  med("Zimax", "Azithromycin", "500 mg", "tablet", "Square"),
  med("Azithrocin", "Azithromycin", "500 mg", "tablet", "Beximco"),
  med("Zimax", "Azithromycin", "200 mg/5 ml", "suspension", "Square"),
  med("Moxacil", "Amoxicillin", "500 mg", "capsule", "Square"),
  med("Fimoxyl", "Amoxicillin", "250 mg", "capsule", "Opsonin"),
  med("Clavusef", "Amoxicillin + Clavulanic acid", "625 mg", "tablet", "Incepta"),
  med("Cef-3", "Cefixime", "200 mg", "capsule", "Square"),
  med("Cefotil", "Cefuroxime", "500 mg", "tablet", "Square"),
  med("Ciprocin", "Ciprofloxacin", "500 mg", "tablet", "Square"),
  med("Levox", "Levofloxacin", "500 mg", "tablet", "Opsonin"),
  med("Doxicap", "Doxycycline", "100 mg", "capsule", "Beximco"),
  med("Fexo", "Fexofenadine", "120 mg", "tablet", "Square"),
  med("Alatrol", "Cetirizine", "10 mg", "tablet", "Square"),
  med("Rupa", "Rupatadine", "10 mg", "tablet", "Incepta"),
  med("Monas", "Montelukast", "10 mg", "tablet", "Acme"),
  med("Montene", "Montelukast", "10 mg", "tablet", "Beximco"),
  med("Azmasol", "Salbutamol", "100 mcg/puff", "inhaler", "Beximco"),
  med("Tusca", "Dextromethorphan + Guaifenesin", "100 ml", "syrup", "Square"),
  med("Adovas", "Adhatoda vasica", "100 ml", "syrup", "Square"),
  med("Deflux", "Budesonide", "100 mcg/puff", "inhaler", "Square"),
  med("Amdocal", "Amlodipine", "5 mg", "tablet", "Beximco"),
  med("Camlodin", "Amlodipine", "5 mg", "tablet", "Square"),
  med("Osartil", "Losartan potassium", "50 mg", "tablet", "Incepta"),
  med("Angilock", "Losartan potassium", "50 mg", "tablet", "Square"),
  med("Bizoran", "Amlodipine + Olmesartan", "5 mg + 20 mg", "tablet", "Beximco"),
  med("Beta", "Atenolol", "50 mg", "tablet", "Square"),
  med("Bisocor", "Bisoprolol", "5 mg", "tablet", "Square"),
  med("Ecosprin", "Aspirin", "75 mg", "tablet", "ACI"),
  med("Clopid", "Clopidogrel", "75 mg", "tablet", "Square"),
  med("Rosuva", "Rosuvastatin", "10 mg", "tablet", "Square"),
  med("Atova", "Atorvastatin", "20 mg", "tablet", "Beximco"),
  med("Comet", "Metformin", "500 mg", "tablet", "Square"),
  med("Glucomet", "Metformin", "850 mg", "tablet", "Beximco"),
  med("Secrin", "Glimepiride", "2 mg", "tablet", "Healthcare"),
  med("Linagliptin", "Linagliptin", "5 mg", "tablet", "Incepta"),
  med("Empa", "Empagliflozin", "10 mg", "tablet", "Square"),
  med("Mixtard 30", "Human insulin (30/70)", "100 IU/ml", "injection", "Novo Nordisk"),
  med("Thyrox", "Levothyroxine", "50 mcg", "tablet", "Renata"),
  med("Neuro-B", "Vitamin B1 + B6 + B12", "100 mg + 200 mg + 200 mcg", "tablet", "Square"),
  med("Calbo-D", "Calcium carbonate + Vitamin D3", "500 mg + 200 IU", "tablet", "Square"),
  med("Coralcal-D", "Calcium carbonate + Vitamin D3", "500 mg + 200 IU", "tablet", "Radiant"),
  med("D-Rise", "Cholecalciferol (Vitamin D3)", "40000 IU", "capsule", "Beximco"),
  med("Fefol", "Ferrous sulphate + Folic acid", "150 mg + 0.5 mg", "capsule", "Eskayef"),
  med("Folison", "Folic acid", "5 mg", "tablet", "Square"),
  med("Zinc", "Zinc sulphate", "20 mg", "tablet", "Square"),
  med("Anafree", "Clonazepam", "0.5 mg", "tablet", "Incepta"),
  med("Rivotril", "Clonazepam", "0.5 mg", "tablet", "Roche"),
  med("Pregaba", "Pregabalin", "75 mg", "capsule", "Square"),
  med("Tory", "Etoricoxib", "90 mg", "tablet", "Incepta"),
  med("Deltasone", "Prednisolone", "5 mg", "tablet", "Square"),
  med("Oradexon", "Dexamethasone", "0.5 mg", "tablet", "Organon"),
  med("Fungidal", "Clotrimazole", "1%", "cream", "Square"),
  med("Betnovate", "Betamethasone valerate", "0.1%", "cream", "GSK"),
  med("Bactroban", "Mupirocin", "2%", "ointment", "GSK"),
  med("Otosporin", "Neomycin + Polymyxin B + Hydrocortisone", "5 ml", "drops", "GSK"),
];

import {
  KnowledgeArticleDocument,
  KnowledgeArticleModel,
  KnowledgeCategory,
} from "../../modules/knowledge/knowledge.model";
import { indexArticle } from "../../modules/knowledge/retrieval";
import { logger } from "../../utils/logger";

/**
 * DEMO KNOWLEDGE BASE — 22 short bilingual articles for the fictional Testolife Hospital.
 * Doctors, fees and schedules are deliberately NOT here (the assistant reads them live from tools).
 * Runs once, when the knowledge base is empty. Articles are published and indexed (embedded when an
 * AI key is configured, otherwise text-search only).
 */
type Seed = { category: KnowledgeCategory; titleEn: string; titleBn: string; contentEn: string; contentBn: string };

export const KNOWLEDGE_ARTICLES: Seed[] = [
  {
    category: "general",
    titleEn: "Outpatient (OPD) timings",
    titleBn: "বহির্বিভাগ (OPD) সময়সূচি",
    contentEn:
      "The outpatient department is open Saturday to Thursday, 9:00 AM to 9:00 PM. Friday is closed for OPD. Each doctor has their own sitting days and times; ask the assistant or reception for a specific doctor's schedule. The Emergency department is open 24 hours, 7 days a week.",
    contentBn:
      "বহির্বিভাগ শনিবার থেকে বৃহস্পতিবার সকাল ৯টা থেকে রাত ৯টা পর্যন্ত খোলা। শুক্রবার বহির্বিভাগ বন্ধ। প্রত্যেক ডাক্তারের বসার দিন ও সময় আলাদা; নির্দিষ্ট ডাক্তারের সময় জানতে অ্যাসিস্ট্যান্ট বা রিসেপশনে জিজ্ঞেস করুন। জরুরি বিভাগ ২৪ ঘণ্টা, সপ্তাহে ৭ দিন খোলা।",
  },
  {
    category: "general",
    titleEn: "Visiting hours for admitted patients",
    titleBn: "ভর্তি রোগী দেখার সময়",
    contentEn:
      "Visitors may see admitted patients from 11:00 AM to 1:00 PM and from 5:00 PM to 7:00 PM. Only two visitors are allowed at a time. Children under 12 are not allowed in the wards. ICU visits are limited to one close relative for 10 minutes, with the nurse's permission.",
    contentBn:
      "ভর্তি রোগী দেখার সময় সকাল ১১টা থেকে দুপুর ১টা এবং বিকেল ৫টা থেকে সন্ধ্যা ৭টা। একসাথে দুজনের বেশি দর্শনার্থী থাকতে পারবেন না। ১২ বছরের কম বয়সী শিশুদের ওয়ার্ডে প্রবেশ নিষেধ। আইসিইউ-তে নার্সের অনুমতি নিয়ে একজন নিকট আত্মীয় ১০ মিনিটের জন্য দেখা করতে পারবেন।",
  },
  {
    category: "appointments",
    titleEn: "How to book an appointment",
    titleBn: "কীভাবে সিরিয়াল নেবেন",
    contentEn:
      "You can book in three ways: 1) chat with the Testo Life Assistant on our website or WhatsApp, 2) call the hospital, 3) come to reception. Appointments can be booked up to 14 days ahead. You get a serial number; please arrive 15 minutes before your time and check in at reception. Patients are seen by serial, but emergencies and elderly patients may be seen first.",
    contentBn:
      "তিনভাবে সিরিয়াল নিতে পারেন: ১) আমাদের ওয়েবসাইট বা হোয়াটসঅ্যাপে Testo Life Assistant-এর সাথে চ্যাট করে, ২) হাসপাতালে ফোন করে, ৩) রিসেপশনে এসে। সর্বোচ্চ ১৪ দিন আগে পর্যন্ত সিরিয়াল নেওয়া যায়। আপনি একটি সিরিয়াল নম্বর পাবেন; সময়ের ১৫ মিনিট আগে এসে রিসেপশনে চেক-ইন করুন। সিরিয়াল অনুযায়ী ডাকা হয়, তবে জরুরি ও বয়স্ক রোগীদের আগে দেখা হতে পারে।",
  },
  {
    category: "appointments",
    titleEn: "Cancelling or changing an appointment",
    titleBn: "সিরিয়াল বাতিল বা পরিবর্তন",
    contentEn:
      "You can cancel or move your appointment through the assistant, by phone or at reception, up to 1 hour before the appointment time. After that, please call the hospital. If you cannot come, please cancel so another patient can use the slot. Moving an appointment gives you a new serial number.",
    contentBn:
      "অ্যাসিস্ট্যান্ট, ফোন বা রিসেপশনের মাধ্যমে অ্যাপয়েন্টমেন্টের সময়ের ১ ঘণ্টা আগে পর্যন্ত সিরিয়াল বাতিল বা পরিবর্তন করা যায়। এর পরে হাসপাতালে ফোন করুন। আসতে না পারলে দয়া করে বাতিল করুন, যাতে অন্য রোগী সুযোগটি পান। সময় বদলালে নতুন সিরিয়াল নম্বর দেওয়া হয়।",
  },
  {
    category: "appointments",
    titleEn: "Follow-up visit fee",
    titleBn: "ফলো-আপ ভিজিটের ফি",
    contentEn:
      "If you visit the same doctor again within the doctor's follow-up period (usually 30 days) after a completed consultation, the lower follow-up fee applies. After that period, the regular consultation fee applies. The exact fee is shown before you confirm a booking.",
    contentBn:
      "কোনো ডাক্তার দেখানোর পর ফলো-আপ সময়ের মধ্যে (সাধারণত ৩০ দিন) একই ডাক্তারকে আবার দেখালে কম ফলো-আপ ফি প্রযোজ্য। এই সময় পার হলে সাধারণ ফি দিতে হবে। সিরিয়াল নিশ্চিত করার আগে সঠিক ফি দেখানো হয়।",
  },
  {
    category: "appointments",
    titleEn: "What to bring on your first visit",
    titleBn: "প্রথম ভিজিটে কী আনবেন",
    contentEn:
      "Please bring: your previous prescriptions and test reports, the medicines you are currently taking (or their names), your national ID or birth certificate for registration, and your mobile phone for the appointment message. For children, bring the vaccination card.",
    contentBn:
      "সাথে আনুন: আগের প্রেসক্রিপশন ও পরীক্ষার রিপোর্ট, বর্তমানে যে ওষুধ খাচ্ছেন (বা সেগুলোর নাম), নিবন্ধনের জন্য জাতীয় পরিচয়পত্র বা জন্মনিবন্ধন, এবং মোবাইল ফোন। শিশুদের ক্ষেত্রে টিকা কার্ড আনুন।",
  },
  {
    category: "appointments",
    titleEn: "Queue and waiting time",
    titleBn: "সিরিয়াল ও অপেক্ষার সময়",
    contentEn:
      "After check-in, your serial number is shown on the TV screen in the waiting area when the doctor calls you. You can also ask the assistant how many people are ahead of you and the estimated waiting time. If you miss your call, tell reception and you will be called again.",
    contentBn:
      "চেক-ইন করার পর ডাক্তার ডাকলে অপেক্ষাকক্ষের টিভিতে আপনার সিরিয়াল নম্বর দেখাবে। আপনার আগে কতজন আছেন এবং আনুমানিক কতক্ষণ অপেক্ষা করতে হবে, তা অ্যাসিস্ট্যান্টের কাছে জানতে পারেন। ডাক মিস করলে রিসেপশনে জানান, আবার ডাকা হবে।",
  },
  {
    category: "payments",
    titleEn: "Payment methods",
    titleBn: "পেমেন্টের পদ্ধতি",
    contentEn:
      "We accept cash, debit and credit cards (Visa, Mastercard), bKash and Nagad. The consultation fee is paid at reception before seeing the doctor. Test fees are paid at the lab counter before the sample is taken. Always ask for a money receipt.",
    contentBn:
      "আমরা নগদ, ডেবিট ও ক্রেডিট কার্ড (ভিসা, মাস্টারকার্ড), বিকাশ ও নগদ গ্রহণ করি। ডাক্তার দেখানোর আগে রিসেপশনে ফি দিতে হয়। পরীক্ষার ফি নমুনা দেওয়ার আগে ল্যাব কাউন্টারে দিতে হয়। অবশ্যই মানি রিসিট নিন।",
  },
  {
    category: "payments",
    titleEn: "Refunds",
    titleBn: "টাকা ফেরত",
    contentEn:
      "If you cancel an appointment you already paid for, the fee is refunded at reception on the same day or can be used for a new appointment within 30 days. Test fees are refunded only if the sample has not been collected yet. Bring your money receipt.",
    contentBn:
      "ফি দেওয়ার পর সিরিয়াল বাতিল করলে একই দিনে রিসেপশন থেকে টাকা ফেরত নিতে পারবেন, অথবা ৩০ দিনের মধ্যে নতুন সিরিয়ালে ব্যবহার করতে পারবেন। নমুনা সংগ্রহ না হয়ে থাকলে পরীক্ষার ফি ফেরত দেওয়া হয়। মানি রিসিট সাথে আনবেন।",
  },
  {
    category: "tests_preparation",
    titleEn: "Fasting blood sugar (FBS) preparation",
    titleBn: "খালি পেটে রক্তের সুগার (FBS) পরীক্ষার প্রস্তুতি",
    contentEn:
      "Do not eat for 8 to 10 hours before the test. You may drink plain water. Do not drink tea, coffee or juice in the morning. Come to the lab in the morning. Take your regular medicines only as your doctor advised.",
    contentBn:
      "পরীক্ষার ৮ থেকে ১০ ঘণ্টা আগে থেকে কিছু খাবেন না। শুধু পানি খেতে পারবেন। সকালে চা, কফি বা জুস খাবেন না। সকালে ল্যাবে আসুন। নিয়মিত ওষুধ ডাক্তারের পরামর্শ অনুযায়ী খাবেন।",
  },
  {
    category: "tests_preparation",
    titleEn: "Lipid profile preparation",
    titleBn: "লিপিড প্রোফাইল পরীক্ষার প্রস্তুতি",
    contentEn:
      "A lipid profile needs 10 to 12 hours of fasting. Eat a normal, light dinner the night before and avoid oily food. Only plain water is allowed in the morning. Please come to the lab before 10 AM.",
    contentBn:
      "লিপিড প্রোফাইলের জন্য ১০ থেকে ১২ ঘণ্টা খালি পেটে থাকতে হয়। আগের রাতে স্বাভাবিক হালকা খাবার খান, তৈলাক্ত খাবার এড়িয়ে চলুন। সকালে শুধু পানি খাওয়া যাবে। সকাল ১০টার আগে ল্যাবে আসুন।",
  },
  {
    category: "tests_preparation",
    titleEn: "Ultrasound (USG) of the whole abdomen preparation",
    titleBn: "পুরো পেটের আল্ট্রাসনোগ্রাম (USG) পরীক্ষার প্রস্তুতি",
    contentEn:
      "For a whole abdomen ultrasound, do not eat for 6 hours before the test. Drink 4 to 5 glasses of water one hour before the test and do not pass urine until the scan, so the bladder is full. For a lower abdomen ultrasound only, a full bladder is enough.",
    contentBn:
      "পুরো পেটের আল্ট্রাসনোগ্রামের জন্য পরীক্ষার ৬ ঘণ্টা আগে থেকে কিছু খাবেন না। পরীক্ষার এক ঘণ্টা আগে ৪–৫ গ্লাস পানি খান এবং পরীক্ষা শেষ না হওয়া পর্যন্ত প্রস্রাব করবেন না, যাতে মূত্রথলি ভরা থাকে। শুধু তলপেটের আল্ট্রাসনোগ্রামের জন্য মূত্রথলি ভরা থাকলেই চলবে।",
  },
  {
    category: "tests_preparation",
    titleEn: "Urine test sample collection",
    titleBn: "প্রস্রাব পরীক্ষার নমুনা দেওয়ার নিয়ম",
    contentEn:
      "Use the sterile container from the lab. Collect the first urine of the morning if possible. Wash your hands, discard the first few drops and collect the middle part of the stream. Bring the sample to the lab within one hour.",
    contentBn:
      "ল্যাব থেকে দেওয়া জীবাণুমুক্ত পাত্র ব্যবহার করুন। সম্ভব হলে সকালের প্রথম প্রস্রাব দিন। হাত ধুয়ে প্রথম কয়েক ফোঁটা ফেলে দিয়ে মাঝের অংশ পাত্রে নিন। এক ঘণ্টার মধ্যে নমুনা ল্যাবে জমা দিন।",
  },
  {
    category: "tests_preparation",
    titleEn: "When lab reports are ready",
    titleBn: "ল্যাব রিপোর্ট কখন পাবেন",
    contentEn:
      "Most blood tests (CBC, blood sugar) are ready the same day within 4 to 6 hours. Lipid profile, liver and kidney tests take up to 12 hours. HbA1c and thyroid tests take up to 24 hours. Every report is checked by a second lab staff member before release. Collect reports from the reception report counter with your money receipt. You can ask the assistant whether your report is ready.",
    contentBn:
      "বেশিরভাগ রক্ত পরীক্ষার (CBC, সুগার) রিপোর্ট একই দিনে ৪–৬ ঘণ্টার মধ্যে পাওয়া যায়। লিপিড প্রোফাইল, লিভার ও কিডনির পরীক্ষায় ১২ ঘণ্টা পর্যন্ত লাগে। HbA1c ও থাইরয়েড পরীক্ষায় ২৪ ঘণ্টা পর্যন্ত লাগে। প্রতিটি রিপোর্ট দ্বিতীয় একজন ল্যাব কর্মী যাচাই করার পর দেওয়া হয়। মানি রিসিট দেখিয়ে রিসেপশনের রিপোর্ট কাউন্টার থেকে রিপোর্ট নিন। রিপোর্ট প্রস্তুত কিনা অ্যাসিস্ট্যান্টের কাছে জানতে পারেন।",
  },
  {
    category: "tests_preparation",
    titleEn: "Lab sample collection hours",
    titleBn: "ল্যাবে নমুনা দেওয়ার সময়",
    contentEn:
      "The lab collects samples from 8:00 AM to 8:00 PM, Saturday to Thursday, and from 9:00 AM to 1:00 PM on Friday. Fasting tests are best done between 8 and 10 in the morning. Emergency samples are taken 24 hours.",
    contentBn:
      "ল্যাবে শনিবার থেকে বৃহস্পতিবার সকাল ৮টা থেকে রাত ৮টা এবং শুক্রবার সকাল ৯টা থেকে দুপুর ১টা পর্যন্ত নমুনা নেওয়া হয়। খালি পেটের পরীক্ষা সকাল ৮টা থেকে ১০টার মধ্যে করানো ভালো। জরুরি নমুনা ২৪ ঘণ্টা নেওয়া হয়।",
  },
  {
    category: "emergency",
    titleEn: "Emergency department",
    titleBn: "জরুরি বিভাগ",
    contentEn:
      "Our Emergency department is open 24 hours with a duty doctor always present. Come directly to the Emergency entrance on the ground floor; no appointment is needed. For chest pain, breathing difficulty, unconsciousness, heavy bleeding or stroke signs, come immediately or call 999.",
    contentBn:
      "আমাদের জরুরি বিভাগ ২৪ ঘণ্টা খোলা, সবসময় ডিউটি ডাক্তার থাকেন। নিচতলার জরুরি বিভাগের প্রবেশপথ দিয়ে সরাসরি চলে আসুন; সিরিয়াল লাগবে না। বুকে ব্যথা, শ্বাসকষ্ট, অজ্ঞান হওয়া, প্রচুর রক্তপাত বা স্ট্রোকের লক্ষণ দেখা দিলে দেরি না করে চলে আসুন অথবা ৯৯৯-এ ফোন করুন।",
  },
  {
    category: "emergency",
    titleEn: "Ambulance service",
    titleBn: "অ্যাম্বুলেন্স সেবা",
    contentEn:
      "The hospital has its own ambulances with oxygen, available 24 hours for Keraniganj and nearby Dhaka areas. Call the emergency number to request one. For a life-threatening emergency anywhere in Bangladesh you can also call 999.",
    contentBn:
      "হাসপাতালের নিজস্ব অক্সিজেনসহ অ্যাম্বুলেন্স কেরানীগঞ্জ ও ঢাকার আশেপাশের এলাকার জন্য ২৪ ঘণ্টা পাওয়া যায়। অ্যাম্বুলেন্সের জন্য জরুরি নম্বরে ফোন করুন। বাংলাদেশের যেকোনো জায়গা থেকে জীবন-সংকটাপন্ন অবস্থায় ৯৯৯-এ ফোন করতে পারেন।",
  },
  {
    category: "directions",
    titleEn: "How to reach the hospital",
    titleBn: "হাসপাতালে কীভাবে আসবেন",
    contentEn:
      "Testolife Hospital is at Arshinagar, Amtola, near Bosila Bridge, Keraniganj, Dhaka. From Mohammadpur, cross Bosila Bridge; the hospital is about 5 minutes from the bridge on the main road at Amtola. CNGs, rickshaws and buses to Keraniganj stop at Amtola bus stand, a 2-minute walk away.",
    contentBn:
      "টেস্টোলাইফ হাসপাতাল আরশিনগর, আমতলা, বসিলা ব্রিজের কাছে, কেরানীগঞ্জ, ঢাকায় অবস্থিত। মোহাম্মদপুর থেকে বসিলা ব্রিজ পার হয়ে প্রধান সড়কে আমতলায় ব্রিজ থেকে প্রায় ৫ মিনিটের পথ। কেরানীগঞ্জগামী সিএনজি, রিকশা ও বাস আমতলা বাসস্ট্যান্ডে থামে, সেখান থেকে ২ মিনিট হাঁটা পথ।",
  },
  {
    category: "facilities",
    titleEn: "Parking",
    titleBn: "পার্কিং",
    contentEn:
      "Free parking for cars and motorcycles is available in the hospital compound. Ambulances have a reserved lane at the Emergency entrance; please do not park there. Parking is limited in the evening, so we suggest using a CNG or rickshaw.",
    contentBn:
      "হাসপাতাল প্রাঙ্গণে গাড়ি ও মোটরসাইকেলের জন্য বিনামূল্যে পার্কিং আছে। জরুরি বিভাগের প্রবেশপথে অ্যাম্বুলেন্সের জন্য সংরক্ষিত লেন আছে; সেখানে গাড়ি রাখবেন না। সন্ধ্যায় পার্কিং সীমিত থাকে, তাই সিএনজি বা রিকশা ব্যবহারের পরামর্শ দেওয়া হচ্ছে।",
  },
  {
    category: "facilities",
    titleEn: "Pharmacy, canteen and prayer room",
    titleBn: "ফার্মেসি, ক্যান্টিন ও নামাজের ঘর",
    contentEn:
      "The hospital pharmacy on the ground floor is open 24 hours. The canteen on the first floor serves meals from 7:00 AM to 10:00 PM. Separate prayer rooms for men and women are on the second floor. Free drinking water and wheelchairs are available at reception.",
    contentBn:
      "নিচতলায় হাসপাতালের ফার্মেসি ২৪ ঘণ্টা খোলা। দোতলায় ক্যান্টিনে সকাল ৭টা থেকে রাত ১০টা পর্যন্ত খাবার পাওয়া যায়। তিনতলায় পুরুষ ও মহিলাদের জন্য আলাদা নামাজের ঘর আছে। রিসেপশনে বিনামূল্যে খাবার পানি ও হুইলচেয়ার পাওয়া যায়।",
  },
  {
    category: "facilities",
    titleEn: "Facilities for elderly and disabled patients",
    titleBn: "বয়স্ক ও প্রতিবন্ধী রোগীদের সুবিধা",
    contentEn:
      "Elderly patients (65 years and above) and patients with disabilities are called with priority in the queue. Wheelchairs and a lift are available, and staff at reception will help you to the doctor's room. Tell reception at check-in if you need help.",
    contentBn:
      "বয়স্ক রোগী (৬৫ বছর ও তার বেশি) এবং প্রতিবন্ধী রোগীদের সিরিয়ালে অগ্রাধিকার দিয়ে ডাকা হয়। হুইলচেয়ার ও লিফট আছে, রিসেপশনের কর্মীরা আপনাকে ডাক্তারের রুম পর্যন্ত পৌঁছে দেবেন। সাহায্য লাগলে চেক-ইনের সময় রিসেপশনে জানান।",
  },
  {
    category: "departments",
    titleEn: "Which department should I visit?",
    titleBn: "কোন বিভাগে যাব?",
    contentEn:
      "Fever, cough, blood pressure, diabetes and general problems: Medicine. Children under 15: Paediatrics. Pregnancy and women's health: Gynaecology & Obstetrics. Heart problems: Cardiology. Bone and joint pain: Orthopaedics. Ear, nose and throat: ENT. Skin problems: Dermatology. If you are not sure, the assistant or reception can suggest a department — the doctor will decide your treatment.",
    contentBn:
      "জ্বর, কাশি, রক্তচাপ, ডায়াবেটিস ও সাধারণ সমস্যা: মেডিসিন। ১৫ বছরের কম বয়সী শিশু: শিশু বিভাগ। গর্ভাবস্থা ও মহিলাদের স্বাস্থ্য: গাইনি ও প্রসূতি। হৃদরোগ: কার্ডিওলজি। হাড় ও জোড়ার ব্যথা: অর্থোপেডিক্স। নাক, কান, গলা: ইএনটি। চর্মরোগ: চর্ম বিভাগ। নিশ্চিত না হলে অ্যাসিস্ট্যান্ট বা রিসেপশন বিভাগ বলে দেবে — চিকিৎসা ডাক্তার ঠিক করবেন।",
  },
];

export const seedKnowledge = async () => {
  if ((await KnowledgeArticleModel.estimatedDocumentCount()) > 0) return;
  const docs = (await KnowledgeArticleModel.insertMany(
    KNOWLEDGE_ARTICLES.map((a) => ({ ...a, status: "published", publishedAt: new Date() })),
  )) as KnowledgeArticleDocument[];
  const methods = new Set<string>();
  for (const d of docs) methods.add(String((await indexArticle(d)).method));
  logger.info(`Knowledge base: ${docs.length} articles published (index: ${[...methods].join(", ")})`);
};

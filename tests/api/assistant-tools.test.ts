import { setAiProvider } from "../../src/ai/ai.service";
import { LabOrderModel } from "../../src/modules/clinical/lab/labOrder.model";
import { ConversationDocument, ConversationModel } from "../../src/modules/assistant/conversation.model";
import { handleInbound } from "../../src/modules/assistant/engine";
import { runTool } from "../../src/modules/assistant/tools";
import { VerificationModel } from "../../src/modules/assistant/verification.model";
import { AppointmentModel } from "../../src/modules/hospital/appointment/appointment.model";
import { createAppointment, createClinic, createPatients, TOMORROW } from "../fixtures";
import { useTestDatabase } from "../helpers";
import { scriptedProvider } from "../assistant-fakes";

const WEB_ID = "d".repeat(32);

describe("Assistant tools", () => {
  useTestDatabase();
  afterEach(() => setAiProvider(undefined));

  const newConv = async (verifiedPhone?: string) =>
    (await ConversationModel.create({
      channel: "web",
      channelUserId: WEB_ID,
      ...(verifiedPhone && { verifiedPhone, phone: verifiedPhone }),
    })) as ConversationDocument;

  const call = async (conv: ConversationDocument, name: string, args: Record<string, unknown> = {}) => {
    const ctx = { conversation: conv, ui: [], bookedAppointmentIds: [] };
    const out = await runTool({ name, args }, ctx);
    return { ...out, ui: ctx.ui };
  };

  it("personal tools refuse to work before the phone is verified", async () => {
    const conv = await newConv();
    const res = await call(conv, "get_my_appointments");
    expect(res.result).toMatchObject({ error: "not_verified" });
    expect(res.log.success).toBe(false);
  });

  it("cannot book for a patient of another phone, even if the model passes that patient's reference or id", async () => {
    const { doctor } = await createClinic();
    const [mine, stranger] = await createPatients(2);
    const conv = await newConv(mine.phone);
    // The model "invents" a reference pointing at somebody else's patient, and a raw database id
    conv.refs.set("P9", String(stranger._id));
    await conv.save();

    const viaRef = await call(conv, "book_appointment", {
      patientRef: "P9",
      doctorId: String(doctor._id),
      date: TOMORROW(),
    });
    expect(viaRef.result).toMatchObject({ error: "That patient is not linked to the verified phone number." });
    const viaId = await call(conv, "book_appointment", {
      patientRef: String(stranger._id),
      doctorId: String(doctor._id),
      date: TOMORROW(),
    });
    expect(viaId.log.success).toBe(false);
    expect(await ConversationModel.findById(conv._id).then((c) => c?.pendingAction)).toBeFalsy();
  });

  it("booking needs an explicit Confirm: the tool only prepares, the button books through the booking service", async () => {
    const { doctor } = await createClinic();
    const [patient] = await createPatients(1);
    const conv = await newConv(patient.phone);
    const list = await call(conv, "list_my_patients");
    const ref = (list.result as { ref: string }[])[0].ref;

    const prepared = await call(conv, "book_appointment", {
      patientRef: ref,
      doctorId: String(doctor._id),
      date: TOMORROW(),
      slotTime: "09:30",
    });
    expect(prepared.result).toMatchObject({ status: "awaiting_confirmation" });
    expect(prepared.ui[0]).toMatchObject({ type: "card", kind: "booking_summary" });
    expect(await AppointmentModel.countDocuments()).toBe(0);

    const pending = (await ConversationModel.findById(conv._id))!.pendingAction!;
    const res = await handleInbound({
      channel: "web",
      channelUserId: WEB_ID,
      replyId: `confirm|${pending.id}`,
      text: "Confirm",
    });
    expect(res.messages[0]).toMatchObject({ type: "card", kind: "booking_success" });
    const appt = await AppointmentModel.findOne();
    expect(appt).toMatchObject({ source: "chatbot", slotTime: "09:30", status: "booked" });
    expect(res.conversation.metrics.bookingsCreated).toBe(1);

    // Pressing the same Confirm again does nothing
    const again = await handleInbound({ channel: "web", channelUserId: WEB_ID, replyId: `confirm|${pending.id}` });
    expect((again.messages[0] as { text: string }).text).toContain("no longer valid");
    expect(await AppointmentModel.countDocuments()).toBe(1);
  });

  it("cancelling also needs Confirm, and only works on the phone's own appointments", async () => {
    const { doctor } = await createClinic();
    const [mine, other] = await createPatients(2);
    const myAppt = await createAppointment({ patient: mine, doctor, status: "booked", date: TOMORROW() });
    await createAppointment({
      patient: other,
      doctor,
      status: "booked",
      date: TOMORROW(),
      slotTime: "09:10",
      serialNo: 2,
    });
    const conv = await newConv(mine.phone);
    await call(conv, "list_my_patients");
    const listed = await call(conv, "get_my_appointments");
    expect(listed.result).toHaveLength(1); // the other patient's appointment is invisible

    const ref = (listed.result as { ref: string }[])[0].ref;
    await call(conv, "cancel_appointment", { appointmentRef: ref });
    expect((await AppointmentModel.findById(myAppt._id))?.status).toBe("booked");
    const pending = (await ConversationModel.findById(conv._id))!.pendingAction!;
    await handleInbound({ channel: "web", channelUserId: WEB_ID, replyId: `confirm|${pending.id}` });
    expect((await AppointmentModel.findById(myAppt._id))?.status).toBe("cancelled");
  });

  it("OTP: hashed storage, typed code verifies, wrong codes are limited, resends are rate limited", async () => {
    const [patient] = await createPatients(1);
    setAiProvider(scriptedProvider([() => ({ text: "ok" })]).provider);
    const conv = await newConv();
    const started = await call(conv, "start_verification", { phone: patient.phone.replace("+88", "") });
    expect(started.ui[0]).toMatchObject({ type: "otp_request" });
    const v = (await VerificationModel.findOne())!;
    expect(v.codeHash).not.toContain(v.devCode!);
    expect(v.expiresAt.getTime() - Date.now()).toBeLessThanOrEqual(5 * 60 * 1000);

    // resend within 60 s is refused
    const resend = await call(conv, "start_verification", { phone: patient.phone.replace("+88", "") });
    expect(resend.result).toMatchObject({ error: expect.stringContaining("wait") });

    // 5 wrong attempts lock the code
    const wrong = v.devCode === "000000" ? "111111" : "000000";
    for (let i = 0; i < 5; i++) await handleInbound({ channel: "web", channelUserId: WEB_ID, text: wrong });
    const locked = await handleInbound({ channel: "web", channelUserId: WEB_ID, text: v.devCode! });
    expect((locked.messages[0] as { text: string }).text).toContain("Too many wrong attempts");
    expect((await ConversationModel.findById(conv._id))?.verifiedPhone).toBeFalsy();
  });

  it("a correct code verifies the phone and shows the family list", async () => {
    const [patient] = await createPatients(1);
    const conv = await newConv();
    await call(conv, "start_verification", { phone: patient.phone });
    const v = (await VerificationModel.findOne())!;
    const res = await handleInbound({ channel: "web", channelUserId: WEB_ID, text: v.devCode! });
    expect(res.messages[1]).toMatchObject({ type: "list", kind: "patients" });
    expect(res.conversation.verifiedPhone).toBe(patient.phone);
  });

  it("lab report status never contains result values", async () => {
    const [patient] = await createPatients(1);
    await LabOrderModel.create({
      orderNo: "LAB-000001",
      patient: patient._id,
      date: TOMORROW(),
      status: "ready",
      orderedBy: patient._id,
      tests: [
        {
          labTest: patient._id,
          name: "HbA1c",
          code: "HBA1C",
          results: [{ name: "HbA1c", value: "9.7", unit: "%", flag: "high" }],
        },
      ],
    });
    const conv = await newConv(patient.phone);
    await call(conv, "list_my_patients");
    const res = await call(conv, "get_lab_report_status");
    const everything = JSON.stringify(res);
    expect(everything).toContain("ready");
    expect(everything).not.toContain("9.7");
    expect(everything).not.toContain("high");
  });
});

import { setAiProvider } from "../../src/ai/ai.service";
import { LabOrderModel } from "../../src/modules/clinical/lab/labOrder.model";
import { ConversationDocument, ConversationModel } from "../../src/modules/assistant/conversation.model";
import { handleInbound } from "../../src/modules/assistant/engine";
import { runTool } from "../../src/modules/assistant/tools";
import { AppointmentModel } from "../../src/modules/hospital/appointment/appointment.model";
import { createAppointment, createClinic, createPatients, TOMORROW } from "../fixtures";
import { useTestDatabase } from "../helpers";

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

  it("personal tools ask for the mobile number first", async () => {
    const conv = await newConv();
    const res = await call(conv, "get_my_appointments");
    expect(res.result).toMatchObject({ error: "no_phone" });
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
    expect(viaRef.result).toMatchObject({
      error: "That patient was not added in this chat. Use register_patient first.",
    });
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

  it("web: a typed number + name/age/gender books without any code", async () => {
    const { doctor } = await createClinic();
    const conv = await newConv();
    expect(await call(conv, "set_phone", { phone: "01711-998877" })).toMatchObject({ result: { status: "saved" } });
    const reg = await call(conv, "register_patient", { name: "Rahima Akter", gender: "female", age: 34 });
    const ref = (reg.result as { patient: { ref: string } }).patient.ref;

    await call(conv, "book_appointment", { patientRef: ref, doctorId: String(doctor._id), date: TOMORROW() });
    const pending = (await ConversationModel.findById(conv._id))!.pendingAction!;
    await handleInbound({ channel: "web", channelUserId: WEB_ID, replyId: `confirm|${pending.id}` });
    const appt = await AppointmentModel.findOne().populate("patient", "name phone");
    expect(appt).toMatchObject({ source: "chatbot", status: "booked" });
    expect(appt!.patient).toMatchObject({ name: "Rahima Akter", phone: "+8801711998877" });

    // The chat sees the appointment it booked
    const fresh = (await ConversationModel.findById(conv._id))! as ConversationDocument;
    const mine = await call(fresh, "get_my_appointments");
    expect(mine.result).toHaveLength(1);
  });

  it("web: typing someone's number never reveals their patients, older appointments or lab tests", async () => {
    const { doctor } = await createClinic();
    const [patient] = await createPatients(1);
    const old = await createAppointment({ patient, doctor, status: "booked", date: TOMORROW() });
    const conv = await newConv();
    await call(conv, "set_phone", { phone: patient.phone });

    expect((await call(conv, "list_my_patients")).result).toEqual([]); // nobody listed by the number alone
    expect((await call(conv, "get_my_appointments")).result).toEqual({ found: 0 });
    expect((await call(conv, "get_lab_report_status")).result).toMatchObject({ error: "not_available_here" });

    // Naming the same person reuses the existing record (no duplicate) — still not their old bookings
    const reg = await call(conv, "register_patient", { name: patient.name, gender: "female", age: 36 });
    expect(reg.result).toMatchObject({ alreadyExists: true });
    expect((await call(conv, "get_my_appointments")).result).toEqual({ found: 0 });

    // An old appointment's id smuggled in as a reference is refused
    conv.refs.set("A9", String(old._id));
    await conv.save();
    const cancel = await call(conv, "cancel_appointment", { appointmentRef: "A9" });
    expect(cancel.log.success).toBe(false);
    expect((await AppointmentModel.findById(old._id))?.status).toBe("booked");
  });

  it("web: changing the number starts fresh", async () => {
    const conv = await newConv();
    await call(conv, "set_phone", { phone: "01711998877" });
    await call(conv, "register_patient", { name: "Rahima Akter", gender: "female", age: 34 });
    expect(conv.linkedPatientIds).toHaveLength(1);
    await call(conv, "set_phone", { phone: "01811998877" });
    expect(conv.linkedPatientIds).toHaveLength(0);
    expect((await call(conv, "set_phone", { phone: "12345" })).log.success).toBe(false);
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

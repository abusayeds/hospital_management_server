import { Server as HttpServer } from "http";
import { Server as SocketIOServer } from "socket.io";
import { env } from "../config/env";
import { Permission, permissionsForRole } from "../config/permissions";
import { ACCESS_COOKIE, readCookie, verifyAccessToken } from "../modules/auth/tokens";
import { DoctorModel } from "../modules/hospital/doctor/doctor.model";
import { isValidDisplayKey } from "../modules/hospital/queue/display-key";
import { IUser, UserModel } from "../modules/users/user.model";
import { logger } from "../utils/logger";

let io: SocketIOServer | null = null;

/**
 * Real-time channel. Every connection lands in rooms that decide what it may hear:
 *  - signed-in staff (access-token cookie): one room per permission ("perm:queue:read"…)
 *    plus "user:<id>"; a doctor also joins "doctor:<doctorId>" for their own queue
 *  - the waiting-room TV (handshake auth.displayKey): the "display" room only —
 *    it receives data-free "something changed" signals and fetches masked data itself
 *  - anyone else: no rooms, hears nothing
 * So an event with patient details only ever reaches people allowed to see it.
 */
export const initSocketIO = (server: HttpServer): SocketIOServer => {
  io = new SocketIOServer(server, {
    cors: { origin: env.CLIENT_URL, credentials: true },
  });

  io.use(async (socket, next) => {
    try {
      if (isValidDisplayKey(socket.handshake.auth?.displayKey)) {
        socket.data.display = true;
        return next();
      }
      const token = readCookie(socket.handshake.headers.cookie, ACCESS_COOKIE);
      if (token) {
        const payload = verifyAccessToken(token);
        const user = await UserModel.findById(payload.sub).lean<IUser & { _id: unknown }>();
        if (user?.isActive && !user.mustChangePassword) {
          socket.data.userId = String(user._id);
          socket.data.permissions = permissionsForRole(user.role);
          if (user.role === "doctor") {
            const doctor = await DoctorModel.findOne({ user: user._id }, { _id: 1 }).lean<{ _id: unknown }>();
            if (doctor) socket.data.doctorId = String(doctor._id);
          }
        }
      }
    } catch {
      // Invalid/expired token → treat as an anonymous connection (no rooms)
    }
    next();
  });

  io.on("connection", (socket) => {
    const permissions: Permission[] = socket.data.permissions ?? [];
    if (socket.data.display) socket.join("display");
    if (socket.data.userId) {
      socket.join(`user:${socket.data.userId}`);
      permissions.forEach((p) => socket.join(`perm:${p}`));
    }
    if (socket.data.doctorId) socket.join(`doctor:${socket.data.doctorId}`);
    logger.debug(
      { socketId: socket.id, authenticated: Boolean(socket.data.userId), display: Boolean(socket.data.display) },
      "Socket connected",
    );
    socket.on("disconnect", (reason) => logger.debug({ socketId: socket.id, reason }, "Socket disconnected"));
  });

  logger.info("Socket.IO ready");
  return io;
};

/** Send an event only to signed-in users who hold `permission`. No-op before init. */
export const emitToPermission = (permission: Permission, event: string, payload: unknown): void => {
  io?.to(`perm:${permission}`).emit(event, payload);
};

/** Send to a named room: "display", "doctor:<id>" */
export const emitToRoom = (room: string, event: string, payload: unknown): void => {
  io?.to(room).emit(event, payload);
};

/** Public signal for everyone (no personal data ever) */
export const emitPublic = (event: string): void => {
  io?.emit(event, { at: new Date().toISOString() });
};

/** Cut the live connections of a user (deactivated, signed out everywhere, password reset) */
export const disconnectUser = (userId: string): void => {
  io?.in(`user:${userId}`).disconnectSockets(true);
};

export const closeSocketIO = async (): Promise<void> => {
  if (!io) return;
  await io.close();
  io = null;
};

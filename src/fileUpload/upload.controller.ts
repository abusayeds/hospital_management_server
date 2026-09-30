import httpStatus from "http-status";
import AppError from "../errors/AppError";
import catchAsync from "../utils/catchAsync";
import sendResponse from "../utils/sendResponse";

export const uploadFile = catchAsync(async (req, res) => {
  if (!req.file) {
    throw new AppError(httpStatus.BAD_REQUEST, "No uploded file ");
  }
  const file = req.file;

  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: "File uploaded",
    data: {
      path: file.path,
      url: `${req.protocol}://${req.get("host")}/images/${file.filename}`,
    },
  });
});

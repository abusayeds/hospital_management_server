import { Response } from "express";
import { TResponse } from "../interface/global.interface";

const sendResponse = <T>(res: Response, data: TResponse<T>) => {
  res.status(data.statusCode).json({
    success: data.success,
    statusCode: data.statusCode,
    message: data?.message,
    pagination: data.pagination,
    data: data.data,
  });
};

export default sendResponse;

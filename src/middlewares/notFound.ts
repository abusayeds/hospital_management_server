import { NextFunction, Request, Response } from "express";
import AppError from "../errors/AppError";

const notFound = (req: Request, _res: Response, next: NextFunction) => {
  next(new AppError(404, `Route not found: ${req.method} ${req.originalUrl}`));
};

export default notFound;

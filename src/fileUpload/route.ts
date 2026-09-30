import express from "express";
import upload from "../middlewares/fileUploadNormal";
import { uploadFile } from "./upload.controller";

const uploadRouter = express.Router();

uploadRouter.post("/", upload.single("file"), uploadFile);

export default uploadRouter;

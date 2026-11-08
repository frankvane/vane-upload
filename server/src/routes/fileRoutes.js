const express = require("express");
const uploadController = require("../controllers/uploadController");
const { uploadChunk } = require("../middleware/uploadChunk");

const router = express.Router();

// VU-31：Express 4 不会自动捕获 async handler 的 rejected Promise。
// 控制器内部虽有 try/catch，但 catch 里的 rollback / unlink 仍可能二次抛错，
// 那会变成 unhandledRejection 并让请求悬挂。统一包一层把错误交给 errorHandler。
const asyncHandler = (fn) => (req, res, next) =>
  Promise.resolve(fn(req, res, next)).catch(next);

router.post("/instant", asyncHandler(uploadController.instantCheck));
router.get("/status", asyncHandler(uploadController.statusQuery));
router.post("/upload", uploadChunk, asyncHandler(uploadController.uploadChunk));
router.post("/merge", asyncHandler(uploadController.mergeChunks));
// E2E-03：删除上传任务时清理服务端残留分片
router.post("/abort", asyncHandler(uploadController.abortUpload));

module.exports = router;

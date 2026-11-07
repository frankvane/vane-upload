const express = require("express");
const uploadController = require("../controllers/uploadController");
const { uploadChunk } = require("../middleware/uploadChunk");

const router = express.Router();

router.post("/instant", uploadController.instantCheck);
router.get("/status", uploadController.statusQuery);
router.post("/upload", uploadChunk, uploadController.uploadChunk);
router.post("/merge", uploadController.mergeChunks);

module.exports = router;

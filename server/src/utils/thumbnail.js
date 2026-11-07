const generateThumbnail = async (inputPath, outputPath, options = {}) => {
  try {
    const sharpModule = await import("sharp");
    const sharp = sharpModule.default;
    const width = options.width || 200;
    const height = options.height || 200;

    await sharp(inputPath).resize(width, height, { fit: "cover" }).toFile(outputPath);
  } catch (error) {
    throw new Error(`thumbnail generation failed: ${error.message}`);
  }
};

module.exports = {
  generateThumbnail,
};

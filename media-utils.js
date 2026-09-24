const path = require('path');
const sharp = require('sharp');

async function createCreativeVariant(imagePath, options = {}) {
    if (options.enabled === false) return null;
    const paddingRatio = Number.isFinite(options.paddingRatio) ? options.paddingRatio : 0.035;
    if (paddingRatio < 0.01 || paddingRatio > 0.08) throw new Error('Creative frame padding is outside safe limits');

    const { data, info } = await sharp(imagePath).rotate().png().toBuffer({ resolveWithObject: true });
    const padding = Math.max(12, Math.round(Math.min(info.width, info.height) * paddingRatio));
    const outputPath = path.join(path.dirname(imagePath), `${path.basename(imagePath, path.extname(imagePath))}.creative.png`);
    await sharp({
        create: {
            width: info.width + padding * 2,
            height: info.height + padding * 2,
            channels: 4,
            background: '#f2f4f2'
        }
    }).composite([{ input: data, left: padding, top: padding }])
        .png({ compressionLevel: 6, adaptiveFiltering: true })
        .toFile(outputPath);
    return outputPath;
}

module.exports = { createCreativeVariant };

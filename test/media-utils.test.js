const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const sharp = require('sharp');
const { createCreativeVariant } = require('../media-utils');

test('creates a lossless temporary framed image without changing the original', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'bot3-media-test-'));
    const originalPath = path.join(directory, 'original.png');
    const originalBytes = await sharp({ create: { width: 200, height: 120, channels: 3, background: '#b82f2f' } })
        .png().toBuffer();
    await fs.writeFile(originalPath, originalBytes);

    try {
        const variantPath = await createCreativeVariant(originalPath, { paddingRatio: 0.05 });
        const after = await fs.readFile(originalPath);
        const originalMeta = await sharp(originalBytes).metadata();
        const variantMeta = await sharp(variantPath).metadata();
        assert.deepEqual(after, originalBytes);
        assert.ok(variantPath !== originalPath);
        assert.ok(variantMeta.width > originalMeta.width);
        assert.ok(variantMeta.height > originalMeta.height);
        assert.equal((await sharp(variantPath).metadata()).format, 'png');
    } finally {
        await fs.rm(directory, { recursive: true, force: true });
    }
});

test('allows image processing to be disabled', async () => {
    assert.equal(await createCreativeVariant('not-read.png', { enabled: false }), null);
});

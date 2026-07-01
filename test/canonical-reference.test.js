const test = require("node:test");
const assert = require("node:assert/strict");
const { PNG } = require("pngjs");

const { prepareCanonicalReference } = require("../src/canonical-reference");

function createPngBuffer(width, height, paintPixel) {
  const png = new PNG({ width, height });

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const index = (y * width + x) * 4;
      const [red, green, blue, alpha = 255] = paintPixel(x, y);
      png.data[index] = red;
      png.data[index + 1] = green;
      png.data[index + 2] = blue;
      png.data[index + 3] = alpha;
    }
  }

  return PNG.sync.write(png);
}

function readPixel(png, x, y) {
  const index = (y * png.width + x) * 4;
  return [
    png.data[index],
    png.data[index + 1],
    png.data[index + 2],
    png.data[index + 3]
  ];
}

function isChromaKeyPixel(pixel) {
  return pixel[0] === 0 && pixel[1] === 255 && pixel[2] === 0 && pixel[3] === 255;
}

function findContentBounds(png) {
  let top = png.height;
  let left = png.width;
  let bottom = -1;
  let right = -1;

  for (let y = 0; y < png.height; y += 1) {
    for (let x = 0; x < png.width; x += 1) {
      if (isChromaKeyPixel(readPixel(png, x, y))) {
        continue;
      }
      top = Math.min(top, y);
      left = Math.min(left, x);
      bottom = Math.max(bottom, y);
      right = Math.max(right, x);
    }
  }

  return {
    top,
    left,
    bottom,
    right
  };
}

test("prepareCanonicalReference 输出 720x1280 并保持比例居中留白", () => {
  const sourcePng = createPngBuffer(4, 2, () => [200, 10, 20, 255]);

  const output = PNG.sync.read(
    prepareCanonicalReference(sourcePng, { backgroundColor: "#00ff00" })
  );

  assert.equal(output.width, 720);
  assert.equal(output.height, 1280);
  assert.deepEqual(readPixel(output, 0, 0), [0, 255, 0, 255]);
  assert.deepEqual(readPixel(output, 719, 1279), [0, 255, 0, 255]);

  const bounds = findContentBounds(output);
  assert.deepEqual(bounds, {
    top: 460,
    left: 0,
    bottom: 819,
    right: 719
  });
  assert.deepEqual(readPixel(output, 360, 640), [200, 10, 20, 255]);
});

test("prepareCanonicalReference 使用双线性缩放平滑混合相邻像素", () => {
  const sourcePng = createPngBuffer(2, 2, (x, y) => {
    if (x === 0 && y === 0) {
      return [0, 0, 0, 255];
    }
    if (x === 1 && y === 0) {
      return [255, 0, 0, 255];
    }
    if (x === 0 && y === 1) {
      return [0, 255, 0, 255];
    }
    return [0, 0, 255, 255];
  });

  const output = PNG.sync.read(
    prepareCanonicalReference(sourcePng, { backgroundColor: "#00ff00" })
  );
  const centerPixel = readPixel(output, 360, 640);

  assert.equal(centerPixel[3], 255);
  assert.ok(centerPixel[0] > 40 && centerPixel[0] < 90);
  assert.ok(centerPixel[1] > 40 && centerPixel[1] < 90);
  assert.ok(centerPixel[2] > 40 && centerPixel[2] < 90);
});

test("prepareCanonicalReference 以预乘 alpha 插值避免透明像素隐藏 RGB 污染边缘", () => {
  const sourcePng = createPngBuffer(2, 1, (x) =>
    x === 0 ? [255, 0, 0, 255] : [0, 0, 255, 0]
  );

  const output = PNG.sync.read(
    prepareCanonicalReference(sourcePng, { backgroundColor: "#00ff00" })
  );
  const edgePixel = readPixel(output, 360, 640);

  assert.equal(edgePixel[3], 255);
  assert.ok(edgePixel[0] >= 126 && edgePixel[0] <= 129);
  assert.ok(edgePixel[1] >= 126 && edgePixel[1] <= 129);
  assert.equal(edgePixel[2], 0);
});

const { PNG } = require("pngjs");

const OUTPUT_WIDTH = 720;
const OUTPUT_HEIGHT = 1280;

function parseHexColor(value) {
  const match = /^#?([0-9a-f]{6})$/i.exec(value || "");
  if (!match) {
    throw new Error("标准参考图背景色必须是 #RRGGBB。");
  }

  const hex = match[1];
  return {
    red: Number.parseInt(hex.slice(0, 2), 16),
    green: Number.parseInt(hex.slice(2, 4), 16),
    blue: Number.parseInt(hex.slice(4, 6), 16)
  };
}

function readPixel(data, width, x, y) {
  const index = (y * width + x) * 4;
  const alpha = data[index + 3];
  const alphaRatio = alpha / 255;
  return {
    red: data[index] * alphaRatio,
    green: data[index + 1] * alphaRatio,
    blue: data[index + 2] * alphaRatio,
    alpha
  };
}

function lerp(start, end, ratio) {
  return start + (end - start) * ratio;
}

function sampleBilinear(png, sourceX, sourceY) {
  const x0 = Math.floor(sourceX);
  const y0 = Math.floor(sourceY);
  const x1 = Math.min(x0 + 1, png.width - 1);
  const y1 = Math.min(y0 + 1, png.height - 1);
  const tx = sourceX - x0;
  const ty = sourceY - y0;

  const topLeft = readPixel(png.data, png.width, x0, y0);
  const topRight = readPixel(png.data, png.width, x1, y0);
  const bottomLeft = readPixel(png.data, png.width, x0, y1);
  const bottomRight = readPixel(png.data, png.width, x1, y1);

  return {
    red: lerp(lerp(topLeft.red, topRight.red, tx), lerp(bottomLeft.red, bottomRight.red, tx), ty),
    green: lerp(
      lerp(topLeft.green, topRight.green, tx),
      lerp(bottomLeft.green, bottomRight.green, tx),
      ty
    ),
    blue: lerp(lerp(topLeft.blue, topRight.blue, tx), lerp(bottomLeft.blue, bottomRight.blue, tx), ty),
    alpha: lerp(
      lerp(topLeft.alpha, topRight.alpha, tx),
      lerp(bottomLeft.alpha, bottomRight.alpha, tx),
      ty
    )
  };
}

function writePixel(data, width, x, y, pixel) {
  const index = (y * width + x) * 4;
  data[index] = pixel.red;
  data[index + 1] = pixel.green;
  data[index + 2] = pixel.blue;
  data[index + 3] = pixel.alpha;
}

function compositeOnBackground(pixel, background) {
  const alpha = pixel.alpha / 255;
  return {
    red: Math.round(pixel.red + background.red * (1 - alpha)),
    green: Math.round(pixel.green + background.green * (1 - alpha)),
    blue: Math.round(pixel.blue + background.blue * (1 - alpha)),
    alpha: 255
  };
}

function prepareCanonicalReference(sourcePng, options = {}) {
  const input = PNG.sync.read(sourcePng);
  const background = parseHexColor(options.backgroundColor || "#00ff00");
  const output = new PNG({
    width: OUTPUT_WIDTH,
    height: OUTPUT_HEIGHT
  });

  for (let y = 0; y < OUTPUT_HEIGHT; y += 1) {
    for (let x = 0; x < OUTPUT_WIDTH; x += 1) {
      writePixel(output.data, OUTPUT_WIDTH, x, y, {
        red: background.red,
        green: background.green,
        blue: background.blue,
        alpha: 255
      });
    }
  }

  const scale = Math.min(OUTPUT_WIDTH / input.width, OUTPUT_HEIGHT / input.height);
  const scaledWidth = Math.max(1, Math.round(input.width * scale));
  const scaledHeight = Math.max(1, Math.round(input.height * scale));
  const offsetX = Math.floor((OUTPUT_WIDTH - scaledWidth) / 2);
  const offsetY = Math.floor((OUTPUT_HEIGHT - scaledHeight) / 2);

  for (let y = 0; y < scaledHeight; y += 1) {
    const sourceY = scaledHeight === 1 ? 0 : (y * (input.height - 1)) / (scaledHeight - 1);

    for (let x = 0; x < scaledWidth; x += 1) {
      const sourceX = scaledWidth === 1 ? 0 : (x * (input.width - 1)) / (scaledWidth - 1);
      const sampled = sampleBilinear(input, sourceX, sourceY);
      writePixel(
        output.data,
        OUTPUT_WIDTH,
        offsetX + x,
        offsetY + y,
        compositeOnBackground(sampled, background)
      );
    }
  }

  return PNG.sync.write(output);
}

module.exports = {
  prepareCanonicalReference
};

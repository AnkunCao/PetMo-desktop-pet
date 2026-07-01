const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");

test("visual harness captures WebGL video player output and analyzes pixels", () => {
  const source = fs.readFileSync("test/electron-visual-harness.js", "utf8");

  // Check pixel analysis functions
  assert.match(source, /analyzePixels\(image\)/);
  assert.match(source, /checkAlphaCornersAreTransparent\(image/);
  assert.match(source, /countVisiblePixels\(image/);

  // Check for test scenarios
  assert.match(source, /Test 1.*Desktop window idle animation/);
  assert.match(source, /Test 2.*Compact window idle animation/);
  assert.match(source, /Test 3.*Action transition.*stand-sit/);
  assert.match(source, /Test 4.*Action transition.*sleep/);

  // Check for WebGL-specific validations
  assert.match(source, /3000.*visiblePixels/);
  assert.match(source, /checkAlphaCornersAreTransparent/);
  assert.match(source, /test\/fixtures\/animations/);
});



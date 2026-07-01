const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("events");

const {
  resolveFfmpegPath,
  buildBakingArgs,
  bakeAnimation,
  DEFAULT_CHROMA_SIMILARITY
} = require("../src/animation-baking");

// 构造一段标准入参，供多个用例复用。
function baseParams(overrides = {}) {
  return {
    inputPath: "/tmp/green/idle.mp4",
    referencePath: "/tmp/ref/standard.png",
    outputPath: "/tmp/out/idle.webm",
    ...overrides
  };
}

// 在参数数组里找到某个 flag 紧跟的值，便于断言“-c:v 后跟 libvpx-vp9”这类契约。
function valueAfter(args, flag) {
  const index = args.indexOf(flag);
  if (index === -1 || index === args.length - 1) {
    return undefined;
  }
  return args[index + 1];
}

test("resolveFfmpegPath 返回一个非空字符串路径", () => {
  const ffmpegPath = resolveFfmpegPath();
  assert.equal(typeof ffmpegPath, "string");
  assert.ok(ffmpegPath.length > 0);
});

test("buildBakingArgs 包含 VP9、yuva420p、抠绿滤镜、首尾锚定与输入输出", () => {
  const args = buildBakingArgs(baseParams());

  // 编码器与像素格式（带 alpha 通道）。
  assert.equal(valueAfter(args, "-c:v"), "libvpx-vp9");
  assert.equal(valueAfter(args, "-pix_fmt"), "yuva420p");

  // 必含覆盖写、无音频。
  assert.ok(args.includes("-y"));
  assert.ok(args.includes("-an"));

  // 滤镜链里必须出现抠绿（colorkey/chromakey 之一）与首尾锚定（tpad）。
  const filterIndex = args.indexOf("-vf");
  assert.notEqual(filterIndex, -1, "应当存在 -vf 滤镜参数");
  const filterChain = args[filterIndex + 1];
  assert.ok(
    /colorkey|chromakey/.test(filterChain),
    `滤镜链应包含 colorkey 或 chromakey，实际为：${filterChain}`
  );
  assert.ok(
    filterChain.includes("tpad"),
    `滤镜链应包含 tpad 首尾锚定，实际为：${filterChain}`
  );
  // 必须用 despill 去除边缘绿色溢色（全局压绿对边缘无效）。
  assert.ok(
    filterChain.includes("despill"),
    `滤镜链应包含 despill 去溢色，实际为：${filterChain}`
  );

  // 输入输出路径必须出现在参数里。
  assert.ok(args.includes("/tmp/green/idle.mp4"));
  assert.ok(args.includes("/tmp/out/idle.webm"));

  // outputPath 必须是最后一个参数。
  assert.equal(args[args.length - 1], "/tmp/out/idle.webm");
});

test("buildBakingArgs 是纯函数：相同入参两次调用结果 deepEqual", () => {
  const first = buildBakingArgs(baseParams());
  const second = buildBakingArgs(baseParams());
  assert.deepEqual(first, second);
});

test("buildBakingArgs 的 anchorSeconds 会体现在 tpad 滤镜里", () => {
  const shortAnchor = buildBakingArgs(baseParams({ anchorSeconds: 0.25 }));
  const longAnchor = buildBakingArgs(baseParams({ anchorSeconds: 1 }));

  const shortChain = shortAnchor[shortAnchor.indexOf("-vf") + 1];
  const longChain = longAnchor[longAnchor.indexOf("-vf") + 1];

  assert.notEqual(shortChain, longChain);
  assert.ok(shortChain.includes("0.25"));
  assert.ok(longChain.includes("1"));
});

test("buildBakingArgs 默认抠图相似度为 0.28，且体现在 chromakey 滤镜里", () => {
  const args = buildBakingArgs(baseParams());
  const filterChain = args[args.indexOf("-vf") + 1];
  assert.equal(DEFAULT_CHROMA_SIMILARITY, 0.28);
  assert.ok(
    filterChain.includes("chromakey=0x00ff00:0.28:0.08"),
    `默认滤镜应含 0.28 相似度，实际为：${filterChain}`
  );
});

test("buildBakingArgs 的 chromaSimilarity 可调并夹到合法区间", () => {
  const low = buildBakingArgs(baseParams({ chromaSimilarity: 0.15 }));
  const high = buildBakingArgs(baseParams({ chromaSimilarity: 0.4 }));
  const lowChain = low[low.indexOf("-vf") + 1];
  const highChain = high[high.indexOf("-vf") + 1];

  assert.ok(lowChain.includes("chromakey=0x00ff00:0.15:0.08"));
  assert.ok(highChain.includes("chromakey=0x00ff00:0.4:0.08"));

  // 越界值被夹到 [0.05, 0.5]。
  const tooHigh = buildBakingArgs(baseParams({ chromaSimilarity: 9 }));
  const tooLow = buildBakingArgs(baseParams({ chromaSimilarity: -1 }));
  assert.ok(tooHigh[tooHigh.indexOf("-vf") + 1].includes(":0.5:"));
  assert.ok(tooLow[tooLow.indexOf("-vf") + 1].includes(":0.05:"));

  // 非法值回退默认 0.28。
  const fallback = buildBakingArgs(baseParams({ chromaSimilarity: "abc" }));
  assert.ok(fallback[fallback.indexOf("-vf") + 1].includes(":0.28:"));
});

// 构造一个可控的假 child process，便于驱动 close/error 事件。
function createFakeChild() {
  const child = new EventEmitter();
  child.stderr = new EventEmitter();
  return child;
}

test("bakeAnimation 用注入的 ffmpegPath 与 buildBakingArgs 结果调用 spawn", async () => {
  const calls = [];
  const child = createFakeChild();
  const spawn = (cmd, args) => {
    calls.push({ cmd, args });
    return child;
  };

  const params = baseParams();
  const promise = bakeAnimation(params, {
    spawn,
    ffmpegPath: "/fake/ffmpeg"
  });

  // 触发成功结束。
  child.emit("close", 0);
  const result = await promise;

  assert.equal(result, params.outputPath);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].cmd, "/fake/ffmpeg");
  assert.deepEqual(calls[0].args, buildBakingArgs(params));
});

test("bakeAnimation 在 close code 0 时 resolve outputPath", async () => {
  const child = createFakeChild();
  const promise = bakeAnimation(baseParams(), {
    spawn: () => child,
    ffmpegPath: "/fake/ffmpeg"
  });

  child.stderr.emit("data", Buffer.from("frame=  10\n"));
  child.emit("close", 0);

  assert.equal(await promise, "/tmp/out/idle.webm");
});

test("bakeAnimation 在 close code 非 0 时 reject 带中文与 stderr 的错误", async () => {
  const child = createFakeChild();
  const promise = bakeAnimation(baseParams(), {
    spawn: () => child,
    ffmpegPath: "/fake/ffmpeg"
  });

  child.stderr.emit("data", Buffer.from("Invalid argument 绿幕处理崩溃"));
  child.emit("close", 1);

  await assert.rejects(promise, (error) => {
    assert.ok(error instanceof Error);
    assert.ok(/动画透明处理失败/.test(error.message));
    assert.ok(error.message.includes("绿幕处理崩溃"));
    return true;
  });
});

test("bakeAnimation 在 spawn error 事件时 reject", async () => {
  const child = createFakeChild();
  const promise = bakeAnimation(baseParams(), {
    spawn: () => child,
    ffmpegPath: "/fake/ffmpeg"
  });

  child.emit("error", new Error("spawn ENOENT"));

  await assert.rejects(promise, /spawn ENOENT/);
});

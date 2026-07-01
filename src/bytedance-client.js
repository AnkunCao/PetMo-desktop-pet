const DEFAULT_BASE_URL = "https://ark.cn-beijing.volces.com/api/v3";

function normalizeBytedanceVideoStatus(status) {
  const normalized = String(status || "").toLowerCase();
  const statuses = {
    queued: "queued",
    pending: "queued",
    running: "in_progress",
    processing: "in_progress",
    succeeded: "completed",
    succeed: "completed",
    failed: "failed",
    canceled: "failed",
    cancelled: "failed"
  };
  if (!statuses[normalized]) {
    throw new Error(`未知的 Bytedance 视频状态：${status}`);
  }
  return statuses[normalized];
}

function createBytedanceClient({
  apiKey,
  fetch,
  baseURL = DEFAULT_BASE_URL,
  requestTimeoutMs = 60_000,
  imageTimeoutMs = 30 * 60_000,
  downloadTimeoutMs = 5 * 60_000
}) {
  if (typeof fetch !== "function") {
    throw new TypeError("Bytedance client requires fetch.");
  }

  async function request(url, options, { timeoutMs, phase, responseType = "json" }) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(url, { ...options, signal: controller.signal });
      if (!response.ok) {
        const error = new Error(response.statusText || `${phase}失败`);
        error.status = response.status;
        try {
          const body = await response.json();
          error.code = body.error?.code || body.code;
          error.requestId = body.error?.request_id || body.request_id;
          error.message = body.error?.message || body.message || error.message;
        } catch {}
        throw error;
      }
      if (responseType === "buffer") {
        const content = await response.arrayBuffer();
        return {
          async arrayBuffer() {
            return content;
          }
        };
      }
      return responseType === "response" ? response : response.json();
    } catch (error) {
      if (controller.signal.aborted || error?.name === "AbortError") {
        const timeoutError = new Error(`Bytedance ${phase}超时，请检查网络后重试。`);
        timeoutError.name = "APIConnectionTimeoutError";
        throw timeoutError;
      }
      throw error;
    } finally {
      clearTimeout(timeoutId);
    }
  }

  function apiRequest(endpoint, method, body, timing) {
    return request(
      `${baseURL}${endpoint}`,
      {
        method,
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json"
        },
        ...(body ? { body: JSON.stringify(body) } : {})
      },
      timing
    );
  }

  async function fileToDataUrl(file) {
    const buffer = await file.arrayBuffer();
    return `data:${file.type || "image/png"};base64,${Buffer.from(buffer).toString("base64")}`;
  }

  function sizeToRatio(size) {
    const match = /^(\d+)x(\d+)$/.exec(String(size || ""));
    if (!match) return "9:16";
    const width = Number(match[1]);
    const height = Number(match[2]);
    const gcd = (a, b) => (b ? gcd(b, a % b) : a);
    const divisor = gcd(width, height) || 1;
    return `${width / divisor}:${height / divisor}`;
  }

  async function retrieveTask(taskId) {
    const data = await apiRequest(
      `/contents/generations/tasks/${encodeURIComponent(taskId)}`,
      "GET",
      null,
      { timeoutMs: requestTimeoutMs, phase: "视频任务查询" }
    );
    const task = data.data || data;
    return {
      id: task.id,
      status: normalizeBytedanceVideoStatus(task.status),
      error: task.error,
      video_url: task.content?.video_url || task.video_url || task.output_video_url || null,
      created_at: task.created_at,
      finished_at: task.updated_at || task.finished_at
    };
  }

  return {
    models: {
      retrieve: async (modelName) => ({ id: modelName })
    },
    images: {
      edit: async (payload) => {
        const image = await Promise.all(payload.image.map(fileToDataUrl));
        const data = await apiRequest(
          "/images/generations",
          "POST",
          {
            model: payload.model,
            prompt: payload.prompt,
            image,
            sequential_image_generation: "disabled",
            response_format: "url",
            size: "2K",
            output_format: "png",
            watermark: false
          },
          { timeoutMs: imageTimeoutMs, phase: "图片生成" }
        );
        const first = Array.isArray(data.data) ? data.data[0] : data.data;
        if (first?.b64_json) return { data: [{ b64_json: first.b64_json }] };
        if (!first?.url) throw new Error("Bytedance 图片接口未返回图片 URL。");
        const response = await request(
          first.url,
          { method: "GET" },
          { timeoutMs: downloadTimeoutMs, phase: "生成图片下载", responseType: "buffer" }
        );
        const content = Buffer.from(await response.arrayBuffer()).toString("base64");
        return { data: [{ b64_json: content }] };
      }
    },
    videos: {
      create: async (payload) => {
        const content = [{ type: "text", text: payload.prompt }];
        if (payload.input_reference) {
          content.push({
            type: "image_url",
            image_url: { url: await fileToDataUrl(payload.input_reference) },
            role: "first_frame"
          });
        }
        if (payload.end_reference) {
          content.push({
            type: "image_url",
            image_url: { url: await fileToDataUrl(payload.end_reference) },
            role: "last_frame"
          });
        }
        const data = await apiRequest(
          "/contents/generations/tasks",
          "POST",
          {
            model: payload.model,
            content,
            ratio: sizeToRatio(payload.size),
            duration: Number.parseInt(payload.seconds, 10),
            watermark: false
          },
          { timeoutMs: requestTimeoutMs, phase: "视频任务创建" }
        );
        const id = data.data?.id || data.id;
        if (!id) throw new Error("Bytedance API 响应缺少任务 ID。");
        return { id };
      },
      retrieve: retrieveTask,
      downloadContent: async (taskId) => {
        const task = await retrieveTask(taskId);
        if (!task.video_url) throw new Error("Bytedance 视频 URL 不可用。");
        return request(
          task.video_url,
          { method: "GET" },
          { timeoutMs: downloadTimeoutMs, phase: "视频下载", responseType: "buffer" }
        );
      }
    }
  };
}

module.exports = {
  createBytedanceClient,
  normalizeBytedanceVideoStatus
};

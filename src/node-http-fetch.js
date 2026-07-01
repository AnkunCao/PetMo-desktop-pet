const http = require("http");
const https = require("https");

const MAX_REDIRECTS = 5;

function createResponse(statusCode, statusMessage, body) {
  const content = Buffer.concat(body);
  return {
    ok: statusCode >= 200 && statusCode < 300,
    status: statusCode,
    statusText: statusMessage || "",
    async json() {
      return JSON.parse(content.toString("utf8"));
    },
    async arrayBuffer() {
      return content.buffer.slice(content.byteOffset, content.byteOffset + content.byteLength);
    }
  };
}

function nodeHttpFetch(url, options = {}, redirectCount = 0) {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const transport = target.protocol === "http:" ? http : https;
    const request = transport.request(
      target,
      {
        method: options.method || "GET",
        headers: options.headers || {},
        insecureHTTPParser: true
      },
      (response) => {
        const statusCode = response.statusCode || 0;
        const location = response.headers.location;
        if (location && statusCode >= 300 && statusCode < 400) {
          response.resume();
          if (redirectCount >= MAX_REDIRECTS) {
            reject(new Error("HTTP 重定向次数过多。"));
            return;
          }
          const nextUrl = new URL(location, target).toString();
          const switchToGet = statusCode === 303 || (
            [301, 302].includes(statusCode) &&
            String(options.method || "GET").toUpperCase() === "POST"
          );
          resolve(nodeHttpFetch(
            nextUrl,
            switchToGet
              ? { ...options, method: "GET", body: undefined }
              : options,
            redirectCount + 1
          ));
          return;
        }

        const chunks = [];
        response.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
        response.on("end", () => {
          resolve(createResponse(statusCode, response.statusMessage, chunks));
        });
        response.on("error", reject);
      }
    );

    const abort = () => {
      request.destroy(Object.assign(new Error("aborted"), { name: "AbortError" }));
    };
    if (options.signal) {
      if (options.signal.aborted) {
        abort();
        return;
      }
      options.signal.addEventListener("abort", abort, { once: true });
      request.once("close", () => options.signal.removeEventListener("abort", abort));
    }
    request.on("error", reject);
    if (options.body !== undefined) {
      request.write(options.body);
    }
    request.end();
  });
}

module.exports = { nodeHttpFetch };

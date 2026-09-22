export type RemoteImage = { url?: string; b64?: string; usage?: unknown }

/** 从 JSON 或 SSE（data: 行）响应里取出第一张图片 */
export function parseImageResponse(body: string): RemoteImage {
  const trimmed = body.trim()

  if (trimmed.startsWith("{")) {
    return fromPayload(JSON.parse(trimmed))
  }

  for (const line of trimmed.split(/\r?\n/)) {
    const raw = line.trim()
    if (!raw.startsWith("data:")) continue
    const payload = raw.slice(5).trim()
    if (!payload || payload === "[DONE]") continue
    try {
      return fromPayload(JSON.parse(payload))
    } catch {
      continue
    }
  }

  throw new Error(`opencode-image: no image in response: ${trimmed.slice(0, 500)}`)
}

function fromPayload(obj: any): RemoteImage {
  const item = obj?.data?.[0] ?? obj
  if (item?.b64_json) return { b64: item.b64_json, usage: obj?.usage ?? item?.usage }
  if (typeof item?.url === "string") return { url: item.url, usage: obj?.usage ?? item?.usage }
  throw new Error(`opencode-image: no image in response payload: ${JSON.stringify(obj).slice(0, 500)}`)
}

/** 把外部 AbortSignal 与超时合并成一个可清理的 signal */
export function withTimeout(external: AbortSignal, ms: number): { signal: AbortSignal; clear: () => void } {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(new Error(`timed out after ${ms}ms`)), ms)
  const forward = () => controller.abort(external.reason)
  if (external.aborted) forward()
  else external.addEventListener("abort", forward, { once: true })
  return {
    signal: controller.signal,
    clear: () => {
      clearTimeout(timer)
      external.removeEventListener("abort", forward)
    },
  }
}

type RequestConfig = { baseURL: string; apiKey: string; model: string; timeoutMs: number }

async function readImage(res: Response, endpoint: string): Promise<RemoteImage> {
  const body = await res.text()
  if (!res.ok) {
    throw new Error(`opencode-image: ${endpoint} HTTP ${res.status}: ${body.slice(0, 500)}`)
  }
  return parseImageResponse(body)
}

/** 下载图片 URL 或 base64 内容为字节 */
export async function fetchImageBytes(image: RemoteImage, signal: AbortSignal): Promise<Buffer> {
  if (image.b64) return Buffer.from(image.b64, "base64")
  if (!image.url) throw new Error("opencode-image: response has neither url nor b64_json")
  const res = await fetch(image.url, { signal })
  if (!res.ok) throw new Error(`opencode-image: image download failed: HTTP ${res.status}`)
  return Buffer.from(await res.arrayBuffer())
}

export async function generateImage(
  config: RequestConfig,
  prompt: string,
  signal: AbortSignal,
): Promise<RemoteImage> {
  const res = await fetch(`${config.baseURL}/images/generations`, {
    method: "POST",
    headers: { Authorization: `Bearer ${config.apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model: config.model, prompt, n: 1 }),
    signal,
  })
  return readImage(res, "POST /images/generations")
}

export async function editImage(
  config: RequestConfig,
  source: Buffer,
  filename: string,
  prompt: string,
  signal: AbortSignal,
): Promise<RemoteImage> {
  const form = new FormData()
  form.append("model", config.model)
  form.append("prompt", prompt)
  form.append("image", new Blob([new Uint8Array(source)], { type: "image/png" }), filename)
  const res = await fetch(`${config.baseURL}/images/edits`, {
    method: "POST",
    headers: { Authorization: `Bearer ${config.apiKey}` },
    body: form,
    signal,
  })
  return readImage(res, "POST /images/edits")
}

/** 插件可配置项，通过 opencode 配置的 `plugin` 元组第二个元素传入 */
export type PluginOptions = {
  /** OpenAI 兼容的图像接口地址，默认从 PI_IMAGE_BASE_URL 读取 */
  baseURL?: string
  /** 接口密钥，默认从 PI_IMAGE_API_KEY 读取 */
  apiKey?: string
  /** 图像模型名 */
  model?: string
  /** 图片输出目录；相对路径基于当前项目目录，默认 <project>/.opencode-images */
  outDir?: string
  /** 落盘图片的最长边上限（像素），超出会等比缩小 */
  maxSize?: number
  /** 在对话里展示的图片最长边（像素）；只影响展示，不影响落盘原图 */
  displayMaxSize?: number
  /** 本地图片服务的空闲关闭时间（毫秒），0 表示不主动关闭 */
  serverIdleMs?: number
  /** 单次图像请求超时（毫秒） */
  timeoutMs?: number
}

export const DEFAULT_BASE_URL = "https://pi-ai.roiscloud.com/v1"
export const DEFAULT_MODEL = "gpt-image-2"
export const DEFAULT_MAX_SIZE = 1024
export const DEFAULT_DISPLAY_MAX_SIZE = 448
export const DEFAULT_SERVER_IDLE_MS = 0
export const DEFAULT_TIMEOUT_MS = 600_000

export type ResolvedOptions = {
  baseURL: string
  apiKey: string
  model: string
  outDir?: string
  maxSize: number
  displayMaxSize: number
  serverIdleMs: number
  timeoutMs: number
}

/** 合并默认值、环境变量与用户配置；缺少 apiKey 时直接抛错 */
export function resolveOptions(options: PluginOptions | undefined): ResolvedOptions {
  const opts = options ?? {}
  const apiKey = opts.apiKey ?? process.env.PI_IMAGE_API_KEY
  if (!apiKey) {
    throw new Error(
      "opencode-image: missing apiKey. Pass it in the plugin options or set PI_IMAGE_API_KEY.",
    )
  }
  return {
    baseURL: (opts.baseURL ?? process.env.PI_IMAGE_BASE_URL ?? DEFAULT_BASE_URL).replace(/\/+$/, ""),
    apiKey,
    model: opts.model ?? DEFAULT_MODEL,
    outDir: opts.outDir,
    maxSize: opts.maxSize ?? DEFAULT_MAX_SIZE,
    displayMaxSize: opts.displayMaxSize ?? DEFAULT_DISPLAY_MAX_SIZE,
    serverIdleMs: opts.serverIdleMs ?? DEFAULT_SERVER_IDLE_MS,
    timeoutMs: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  }
}

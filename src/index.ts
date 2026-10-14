import { Plugin } from "@opencode/plugin"
import { Schema } from "effect"
import * as fs from "node:fs"
import * as path from "node:path"
import { editImage, fetchImageBytes, generateImage, withTimeout } from "./api.js"
import { PreviewCache, humanAge, humanBytes } from "./cache.js"
import { imageDimensions, persistImage, toPngBuffer } from "./image.js"
import { resolveOptions, resolveOutDir, type PluginOptions, type ResolvedOptions } from "./options.js"
import { checkForUpdate, readOwnVersion } from "./update.js"
import { ImageServer } from "./server.js"

const PLUGIN_ID = "opencode-image"

const GENERATE_DESCRIPTION =
  "Generate an image from a text prompt. This is the only supported way to create images in this session: " +
  "the endpoint and API key are already configured inside this plugin, so NEVER call the image API yourself " +
  "(no curl, no scripts) and never read the API key out of opencode.json. " +
  "The first line of the output is a Markdown image line (plus a separate 查看原图 link when displayMaxSize > 0); " +
  "you MUST copy those lines verbatim into your reply text, otherwise the user cannot see the picture. " +
  "If the output contains a line starting with [请转述给用户], relay that line to the user as well. " +
  "To refine a result, call image_edit with the returned path instead of generating a new image."

const EDIT_DESCRIPTION =
  "Edit an existing image with a text instruction (image-to-image). Prefer this over generating a new image " +
  "when the user wants to adjust a picture: pass the exact path returned by a previous image_generate or " +
  "image_edit call to keep refining the same one. " +
  "Same rules: never call the image API yourself and never read the API key; copy the Markdown image line " +
  "(and the 查看原图 link, if present) from the output verbatim into your reply, and relay any line starting " +
  "with [请转述给用户]."

const CACHE_DESCRIPTION =
  "Inspect or clear the preview-thumbnail cache used for rendering images in the conversation. " +
  'Use action="status" to report the cache directory, file count, total size and age of the oldest entry; ' +
  'action="clean" to delete every cached preview (the generated images in outDir are NOT touched). ' +
  "This returns text only — do not turn it into a Markdown image line."

const SYSTEM_RULE =
  "Image generation/editing: always use the `image_generate` / `image_edit` tools provided by the " +
  "opencode-image plugin — the endpoint and API key are already configured there. Never call the image API " +
  "directly, never read the API key from config, and do not use the imagegen skill or its CLI. Copy the " +
  "Markdown image line from that tool's output verbatim into your reply so the user can see the picture."

const GenerateInput = Schema.Struct({
  prompt: Schema.String,
  filename: Schema.optional(Schema.String),
})

const EditInput = Schema.Struct({
  image: Schema.String,
  prompt: Schema.String,
  filename: Schema.optional(Schema.String),
})

const CacheInput = Schema.Struct({
  action: Schema.Literals(["status", "clean"]),
})

function resolveDestination(filename: string | undefined, options: ResolvedOptions, directory: string) {
  const dir = resolveOutDir(directory, options.outDir)

  if (filename) {
    const target = path.isAbsolute(filename) ? filename : path.join(dir, filename)
    return `${target.replace(/\.[A-Za-z0-9]+$/, "")}.png`
  }
  const stamp = new Date().toISOString().replace(/\..+$/, "").replace(/[:T]/g, "-")
  const suffix = Math.random().toString(36).slice(2, 6)
  return path.join(dir, `image-${stamp}-${suffix}.png`)
}

function asAttachment(file: string) {
  return {
    type: "file" as const,
    mime: "image/png",
    name: path.basename(file),
    uri: `data:image/png;base64,${fs.readFileSync(file).toString("base64")}`,
  }
}

export const OpenCodeImagePlugin = Plugin.define({
  id: PLUGIN_ID,
  setup: async (ctx) => {
    const options = resolveOptions(ctx.options as PluginOptions | undefined)
    const directory = ctx.location.directory
    const outDir = resolveOutDir(directory, options.outDir)
    const cache = new PreviewCache(options.cacheDir, options.cacheLimit)
    const server = new ImageServer(options.serverIdleMs, options.serverPort, cache)

    // 首次出图时查一次 npm 最新版；结果在进程内缓存，最多查一次
    const selfVersion = readOwnVersion()
    let updateHint: string | undefined
    let updateChecked = false
    const upgradeNotice = async () => {
      if (!options.updateCheck || updateChecked || !selfVersion) return updateHint
      updateChecked = true
      updateHint = await checkForUpdate(selfVersion)
      return updateHint
    }

    /**
     * 组装工具返回值。
     * 关键点：桌面端只在助手回复的 Markdown 正文里渲染图片，
     * 所以第一行给出可直接粘贴进正文的 Markdown 图片，走本地 HTTP。
     */
    const render = async (label: string, prompt: string, file: string, progress: (m: string) => void, usage: unknown) => {
      const { width, height } = await imageDimensions(file)
      let display: string
      try {
        await server.start({ outDir })
        const alt = prompt.slice(0, 60)
        const lines = [`![${alt}](${server.url(file, options.displayMaxSize)})`]
        // 客户端不支持「图片套链接」（link renderer 取的是原始文本），
        // 所以缩略图模式下另起一行给一个指向原图的普通链接
        if (options.displayMaxSize > 0) lines.push(`[查看原图](${server.url(file, 0)})`)
        display = lines.join("\n")
      } catch (error) {
        display = `[opencode-image: local image server unavailable, cannot render inline: ${String(error)}]`
      }
      const notice = await upgradeNotice()
      const output = [
        display,
        `${label} saved to ${file} (${width}x${height})`,
        `Refine it by calling image_edit with image="${file}" and a prompt describing the change.`,
        `IMPORTANT: copy the Markdown image line above verbatim into your reply text, otherwise the user cannot see the picture.`,
      ]
      if (notice) output.push(notice)
      // 缩略图缓存的溢出通知在「上一次图片被客户端请求」时产生，这里顺带展示
      const cacheNotice = server.consumeCacheNotice()
      if (cacheNotice) output.push(cacheNotice)

      progress(`${label}: ${prompt.slice(0, 60)}`)
      return {
        content: [{ type: "text" as const, text: output.join("\n") }, asAttachment(file)],
        metadata: { file, prompt, usage },
      }
    }

    await ctx.tool.transform((tools) => {
      tools.add({
        name: "image_generate",
        description: GENERATE_DESCRIPTION,
        input: GenerateInput,
        options: { codemode: false },
        execute: async (args, toolCtx) => {
          const title = `Generating image: ${args.prompt.slice(0, 60)}`
          await toolCtx.progress({ title })
          const { signal, clear } = withTimeout(toolCtx.signal, options.timeoutMs)
          try {
            const remote = await generateImage(options, args.prompt, signal)
            const raw = await fetchImageBytes(remote, signal)
            const destination = resolveDestination(args.filename, options, directory)
            await persistImage(raw, destination, options.maxSize)
            return await render("Image generated", args.prompt, destination, (m) => void toolCtx.progress({ title: m }), remote.usage)
          } finally {
            clear()
          }
        },
      })

      tools.add({
        name: "image_edit",
        description: EDIT_DESCRIPTION,
        input: EditInput,
        options: { codemode: false },
        execute: async (args, toolCtx) => {
          const source = path.isAbsolute(args.image) ? args.image : path.resolve(directory, args.image)
          if (!fs.existsSync(source)) throw new Error(`image_edit: source image not found: ${source}`)

          const title = `Editing image: ${args.prompt.slice(0, 60)}`
          await toolCtx.progress({ title })
          const { signal, clear } = withTimeout(toolCtx.signal, options.timeoutMs)
          try {
            const upload = await toPngBuffer(source, options.maxSize)
            const remote = await editImage(
              options,
              upload,
              `${path.basename(source, path.extname(source))}.png`,
              args.prompt,
              signal,
            )
            const raw = await fetchImageBytes(remote, signal)
            const destination = resolveDestination(args.filename, options, directory)
            await persistImage(raw, destination, options.maxSize)
            return await render("Image edited", args.prompt, destination, (m) => void toolCtx.progress({ title: m }), remote.usage)
          } finally {
            clear()
          }
        },
      })

      tools.add({
        name: "image_cache",
        description: CACHE_DESCRIPTION,
        input: CacheInput,
        options: { codemode: false },
        execute: async (args) => {
          if (args.action === "clean") {
            const removed = server.cleanCache()
            return {
              content: [
                `已清理 ${removed.count} 个预览文件，共 ${humanBytes(removed.bytes)}。`,
                `缓存目录：${removed.dir}`,
                `注意：这不影响 outDir 里的原图，会话里的图片仍能正常显示（需要时会重新生成缩略图）。`,
              ].join("\n"),
              metadata: removed,
            }
          }
          const stats = server.cacheStats()
          return {
            content: [
              `缓存目录：${stats.dir}`,
              `文件数量：${stats.count}`,
              `占用大小：${humanBytes(stats.bytes)}`,
              `最旧一个：${stats.oldestMs === undefined ? "（空缓存）" : `已存在 ${humanAge(stats.oldestMs)}`}`,
              `上限：${options.cacheLimit} 个（可通过 cacheLimit 配置，0 = 不限制）`,
            ].join("\n"),
            metadata: stats,
          }
        },
      })
    })

    /**
     * 让模型稳定地走我们的工具：工具描述只在模型真去看工具时才有用，
     * 这里往系统提示里加一条，避免它跑去用 imagegen skill 或自己 curl 调接口。
     */
    if (options.injectPrompt)
      await ctx.session.hook("context", (event) => {
        event.system.push({ type: "text", text: SYSTEM_RULE })
      })

    return () => server.stop()
  },
})

export default OpenCodeImagePlugin

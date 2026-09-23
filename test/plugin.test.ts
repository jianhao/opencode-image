import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { fileURLToPath } from "node:url"
import sharp from "sharp"
import { OpenCodeImagePlugin } from "../src/index.js"
import { ImageServer, derivePort } from "../src/server.js"
import { isNewer } from "../src/update.js"
import { PreviewCache } from "../src/cache.js"
import { defaultImageDir, resolveOutDir } from "../src/options.js"
import { execFileSync } from "node:child_process"

const realFetch = globalThis.fetch
const root = fs.mkdtempSync(path.join(os.tmpdir(), "opencode-image-test-"))
const cacheDir = path.join(root, "preview-cache")

afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true })
})

let payload: Buffer

beforeAll(() => {
  globalThis.fetch = (async (input: any, init: any) => {
    const url = typeof input === "string" ? input : input.url
    if (url.includes("/images/generations") || url.includes("/images/edits")) {
      return new Response(JSON.stringify({ data: [{ b64_json: payload.toString("base64") }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    }
    return realFetch(input, init)
  }) as typeof fetch
})

afterAll(() => {
  globalThis.fetch = realFetch
})

let portSeed = 45100
let instanceSeed = 0

async function useHooks(extra: Record<string, unknown> = {}) {
  const seed = instanceSeed++
  return OpenCodeImagePlugin({} as any, {
    apiKey: "test-key",
    maxSize: 1024,
    displayMaxSize: 448,
    // 测试里显式指定端口：派生端口依赖目录哈希，跨测试目录可能相撞导致偶发失败
    serverPort: portSeed++,
    // 测试不打网络；显式指定 outDir 与 cacheDir，避免写进真实的全局目录
    updateCheck: false,
    outDir: path.join(root, "images", `g${seed}`),
    cacheDir: path.join(cacheDir, `p${seed}`),
    ...extra,
  } as any)
}

async function usePlugin(extra: Record<string, unknown> = {}) {
  return (await useHooks(extra)).tool as any
}

/** displayMaxSize = 0 时没有 ?w= 参数，单独取一次 */
function fullSizeUrl(output: string) {
  const match = /!\[[^\]]*\]\((http:\/\/127\.0\.0\.1:\d+\/img\/[^)]+)\)/.exec(output)
  if (!match) throw new Error(`no image url in tool output:\n${output}`)
  return match[1]
}

function context(directory: string) {
  return {
    sessionID: "s",
    messageID: "m",
    agent: "test",
    directory,
    worktree: directory,
    abort: new AbortController().signal,
    metadata: () => {},
    ask: async () => {},
  } as any
}

function png(width: number, height: number) {
  return sharp({
    create: { width, height, channels: 3, background: { r: 200, g: 40, b: 40 } },
  })
    .png()
    .toBuffer()
}

function urlFrom(output: string) {
  const match = /\((http:\/\/127\.0\.0\.1:\d+\/img\/[A-Za-z0-9_-]+(?:\/[^)?]*)?\?w=\d+)\)/.exec(output)
  if (!match) throw new Error(`no inline image url in tool output:\n${output}`)
  return match[1]
}

describe("image_generate", () => {
  test("saves the full-size image and serves a downscaled preview", async () => {
    payload = await png(1600, 1600)
    const dir = path.join(root, "generate")
    const tools = await usePlugin()

    const res = await tools.image_generate.execute({ prompt: "a red square" }, context(dir))

    expect(res.output).toContain("IMPORTANT: copy the Markdown image line")
    expect(res.attachments?.[0]?.mime).toBe("image/png")
    // 客户端不支持图片套链接，缩略图模式下必须是「图片 + 单独链接行」
    expect(res.output).not.toContain("[![")
    expect(res.output).toContain("[查看原图](")

    const savedMeta = await sharp(res.metadata.file).metadata()
    expect([savedMeta.width, savedMeta.height]).toEqual([1024, 1024])

    const res2 = await realFetch(urlFrom(res.output))
    expect(res2.status).toBe(200)
    expect(res2.headers.get("content-type")).toBe("image/png")
    const served = await sharp(Buffer.from(await res2.arrayBuffer())).metadata()
    expect([served.width, served.height]).toEqual([448, 448])
  })

  test("displayMaxSize = 0 serves the original with no extra link", async () => {
    payload = await png(900, 900)
    const dir = path.join(root, "full-size")
    const tools = await usePlugin({ displayMaxSize: 0 })

    const res = await tools.image_generate.execute({ prompt: "full size" }, context(dir))

    expect(res.output).not.toContain("?w=")
    expect(res.output).not.toContain("[查看原图](")

    const served = await realFetch(fullSizeUrl(res.output))
    expect(served.status).toBe(200)
    const meta = await sharp(Buffer.from(await served.arrayBuffer())).metadata()
    expect([meta.width, meta.height]).toEqual([900, 900])
  })

  test("never upscales a preview", async () => {
    payload = await png(200, 160)
    const dir = path.join(root, "small")
    const tools = await usePlugin()

    const res = await tools.image_generate.execute({ prompt: "tiny" }, context(dir))

    const served = await realFetch(urlFrom(res.output))
    const meta = await sharp(Buffer.from(await served.arrayBuffer())).metadata()
    expect([meta.width, meta.height]).toEqual([200, 160])
  })

  test("respects an explicit filename", async () => {
    payload = await png(600, 600)
    const dir = path.join(root, "named")
    const tools = await usePlugin()

    const target = path.join(dir, "custom.png")
    await tools.image_generate.execute({ prompt: "named", filename: target }, context(dir))

    expect(fs.existsSync(target)).toBe(true)
    expect(fs.existsSync(`${target}.download`)).toBe(false)
  })
})

describe("image_edit", () => {
  test("normalizes a jpeg source to a png result", async () => {
    payload = await png(800, 800)
    const dir = path.join(root, "edit")
    fs.mkdirSync(dir, { recursive: true })
    const source = path.join(dir, "source.jpg")
    fs.writeFileSync(source, await sharp({ create: { width: 300, height: 300, channels: 3, background: "#0af" } }).jpeg().toBuffer())

    const tools = await usePlugin()
    const res = await tools.image_edit.execute(
      { image: source, prompt: "make it blue", filename: path.join(dir, "edited.png") },
      context(dir),
    )

    const out = path.join(dir, "edited.png")
    const bytes = fs.readFileSync(out)
    expect([...bytes.subarray(0, 4)]).toEqual([0x89, 0x50, 0x4e, 0x47])
    expect(await sharp(out).metadata()).toMatchObject({ format: "png", width: 800 })
    expect(res.output).toContain("Image edited")
  })

  test("rejects a missing source", async () => {
    const tools = await usePlugin()
    await expect(
      tools.image_edit.execute({ image: "/nope/missing.png", prompt: "x" }, context(root)),
    ).rejects.toThrow("source image not found")
  })
})

describe("image server", () => {
  test("derives a stable port from the project directory", () => {
    expect(derivePort("/a/b/c")).toBe(derivePort("/a/b/c"))
    expect(derivePort("/a/b/c")).toBeGreaterThanOrEqual(41000)
    expect(derivePort("/a/b/c")).toBeLessThan(45000)
  })

  test("404s unknown ids and path traversal", async () => {
    payload = await png(500, 500)
    const dir = path.join(root, "security")
    const tools = await usePlugin()
    const res = await tools.image_generate.execute({ prompt: "security" }, context(dir))

    const url = new URL(urlFrom(res.output))
    const unknown = await realFetch(new URL("/img/deadbeefdeadbeef", url).toString())
    expect(unknown.status).toBe(404)

    const traversal = await realFetch(new URL("/img/..%2f..%2f..%2fetc%2fpasswd", url).toString())
    expect(traversal.status).toBe(404)

    const file = await realFetch(new URL("/img/", url).toString())
    expect(file.status).toBe(404)
  })

  test("a fresh server keeps serving a url minted before the restart", async () => {
    const dir = path.join(root, "restart")
    const outDir = path.join(dir, ".opencode-images")
    fs.mkdirSync(outDir, { recursive: true })
    const file = path.join(outDir, "kept.png")
    fs.writeFileSync(file, await png(300, 200))

    const cache = new PreviewCache(cacheDir, 50)
    const before = new ImageServer(0, 45200, cache)
    await before.start({ outDir })
    const url = before.url(file, 448)
    before.stop()

    const after = new ImageServer(0, 45200, cache)
    await after.start({ outDir })
    expect(after.url(file, 448)).toBe(url)

    const res = await realFetch(url)
    expect(res.status).toBe(200)
    expect(res.headers.get("content-type")).toBe("image/png")
    after.stop()
  })

  test("refuses to serve files outside outDir", async () => {
    const dir = path.join(root, "containment")
    const outDir = path.join(dir, ".opencode-images")
    fs.mkdirSync(outDir, { recursive: true })
    const secret = path.join(root, "secret.png")
    fs.writeFileSync(secret, await png(64, 64))

    const server = new ImageServer(0, 45201, new PreviewCache(cacheDir, 50))
    await server.start({ outDir })
    const escaped = Buffer.from(path.relative(outDir, secret)).toString("base64url")
    const res = await realFetch(`${server.baseURL}/img/${escaped}`)
    expect(res.status).toBe(404)
    server.stop()
  })

  test("reuses one port across generations", async () => {
    payload = await png(500, 500)
    const dir = path.join(root, "reuse")
    const tools = await usePlugin()

    const a = await tools.image_generate.execute({ prompt: "a" }, context(dir))
    const b = await tools.image_generate.execute({ prompt: "b" }, context(dir))

    expect(new URL(urlFrom(a.output)).port).toBe(new URL(urlFrom(b.output)).port)
  })
})

describe("update check", () => {
  test("compares versions", () => {
    expect(isNewer("0.1.2", "0.1.1")).toBe(true)
    expect(isNewer("0.1.1", "0.1.1")).toBe(false)
    expect(isNewer("0.0.9", "0.1.0")).toBe(false)
    expect(isNewer("1.0.0", "0.9.9")).toBe(true)
    expect(isNewer("1.0.0", "1.0.0-beta")).toBe(true)
    expect(isNewer("1.0.0-beta", "1.0.0")).toBe(false)
  })

  test("--update removes only this package's cache dirs", () => {
    const cache = fs.mkdtempSync(path.join(root, "cli-cache-"))
    for (const name of ["opencode-image", "opencode-image@latest", "opencode-image@0.1.0", "other-plugin"]) {
      fs.mkdirSync(path.join(cache, name), { recursive: true })
    }

    const cli = fileURLToPath(new URL("../bin/cli.js", import.meta.url))
    const out = execFileSync(process.execPath, [cli, "--update"], {
      env: { ...process.env, OPENCODE_IMAGE_PLUGIN_CACHE: cache },
      encoding: "utf8",
    })

    expect(out).toContain("已清理 3 个缓存目录")
    expect(fs.existsSync(path.join(cache, "opencode-image"))).toBe(false)
    expect(fs.existsSync(path.join(cache, "opencode-image@latest"))).toBe(false)
    expect(fs.existsSync(path.join(cache, "opencode-image@0.1.0"))).toBe(false)
    expect(fs.existsSync(path.join(cache, "other-plugin"))).toBe(true)
  })
})

describe("output directory", () => {
  test("defaults to the opencode data dir, not the project", () => {
    expect(defaultImageDir({}, "/home/u")).toBe("/home/u/.local/share/opencode/opencode-image")
    expect(defaultImageDir({ XDG_DATA_HOME: "/xdg" }, "/home/u")).toBe("/xdg/opencode/opencode-image")
  })

  test("resolves relative outDir against the project and keeps absolute paths", () => {
    expect(resolveOutDir("/proj", undefined)).toBe(defaultImageDir())
    expect(resolveOutDir("/proj", ".opencode-images")).toBe(path.join("/proj", ".opencode-images"))
    expect(resolveOutDir("/proj", "/abs/dir")).toBe("/abs/dir")
  })
})

describe("system prompt rule", () => {
  test("injects the tool guidance by default", async () => {
    const hooks = await useHooks()
    const output = { system: [] as string[] }
    await hooks["experimental.chat.system.transform"]!({} as any, output)
    expect(output.system.join("\n")).toContain("image_generate")
  })

  test("can be turned off", async () => {
    const hooks = await useHooks({ injectPrompt: false })
    const output = { system: [] as string[] }
    await hooks["experimental.chat.system.transform"]!({} as any, output)
    expect(output.system).toEqual([])
  })
})

describe("preview cache", () => {
  test("evicts down to the limit and reports once", async () => {
    const dir = fs.mkdtempSync(path.join(root, "lru-"))
    const cache = new PreviewCache(path.join(dir, "cache"), 2)
    const staging = path.join(dir, "staging")
    fs.mkdirSync(staging, { recursive: true })

    for (const name of ["a.png", "b.png", "c.png"]) {
      const source = path.join(dir, name)
      fs.writeFileSync(source, await png(64, 64))
      const generated = path.join(staging, name)
      fs.writeFileSync(generated, await png(32, 32))
      cache.put(source, 448, generated)
    }

    expect(cache.stats().count).toBe(2)

    const notice = cache.consumeNotice()
    expect(notice).toContain("已达上限")
    expect(notice).toContain("[请转述给用户]")
    expect(notice).toContain("clean")
    expect(cache.consumeNotice()).toBeUndefined() // 只提醒一次

    const removed = cache.clean()
    expect(removed.count).toBe(2)
    expect(cache.stats().count).toBe(0)
  })

  test("reuses the same cache file for the same source and size", async () => {
    const dir = fs.mkdtempSync(path.join(root, "reuse-cache-"))
    const cache = new PreviewCache(path.join(dir, "cache"), 10)
    const source = path.join(dir, "one.png")
    fs.writeFileSync(source, await png(64, 64))

    const generated = path.join(dir, "generated.png")
    fs.writeFileSync(generated, await png(32, 32))
    const stored = cache.put(source, 448, generated)

    expect(cache.hit(source, 448)).toBe(stored)
    expect(cache.stats().count).toBe(1)
  })
})

test("image_cache reports and clears previews", async () => {
  payload = await png(600, 600)
  const dir = path.join(root, "cache-tool")
  const tools = await usePlugin()

  const generated = await tools.image_generate.execute({ prompt: "cache" }, context(dir))
  await realFetch(urlFrom(generated.output)) // 缩略图只在客户端真正请求时才写入缓存

  expect((await tools.image_cache.execute({ action: "status" }, context(dir))).output).toContain("文件数量：1")

  const cleaned = await tools.image_cache.execute({ action: "clean" }, context(dir))
  expect(cleaned.output).toContain("已清理 1 个预览文件")

  expect((await tools.image_cache.execute({ action: "status" }, context(dir))).output).toContain("文件数量：0")
})

test("fails fast without an apiKey", async () => {
  const previous = process.env.PI_IMAGE_API_KEY
  delete process.env.PI_IMAGE_API_KEY
  expect(OpenCodeImagePlugin({} as any, {} as any)).rejects.toThrow("missing apiKey")
  if (previous) process.env.PI_IMAGE_API_KEY = previous
})

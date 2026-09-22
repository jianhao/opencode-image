import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import sharp from "sharp"
import { OpenCodeImagePlugin } from "../src/index.js"

const realFetch = globalThis.fetch
const root = fs.mkdtempSync(path.join(os.tmpdir(), "opencode-image-test-"))

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

async function usePlugin() {
  const plugin = await OpenCodeImagePlugin({} as any, {
    apiKey: "test-key",
    maxSize: 1024,
    displayMaxSize: 448,
  } as any)
  return plugin.tool as any
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
  const match = /\((http:\/\/127\.0\.0\.1:\d+\/img\/[0-9a-f]+\?w=\d+)\)/.exec(output)
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

    const saved = path.join(dir, ".opencode-images")
    const file = fs.readdirSync(saved)[0]
    const savedMeta = await sharp(path.join(saved, file)).metadata()
    expect([savedMeta.width, savedMeta.height]).toEqual([1024, 1024])

    const res2 = await realFetch(urlFrom(res.output))
    expect(res2.status).toBe(200)
    expect(res2.headers.get("content-type")).toBe("image/png")
    const served = await sharp(Buffer.from(await res2.arrayBuffer())).metadata()
    expect([served.width, served.height]).toEqual([448, 448])
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

  test("reuses one port across generations", async () => {
    payload = await png(500, 500)
    const dir = path.join(root, "reuse")
    const tools = await usePlugin()

    const a = await tools.image_generate.execute({ prompt: "a" }, context(dir))
    const b = await tools.image_generate.execute({ prompt: "b" }, context(dir))

    expect(new URL(urlFrom(a.output)).port).toBe(new URL(urlFrom(b.output)).port)
  })
})

test("fails fast without an apiKey", async () => {
  const previous = process.env.PI_IMAGE_API_KEY
  delete process.env.PI_IMAGE_API_KEY
  expect(OpenCodeImagePlugin({} as any, {} as any)).rejects.toThrow("missing apiKey")
  if (previous) process.env.PI_IMAGE_API_KEY = previous
})

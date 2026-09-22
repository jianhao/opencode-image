import * as fs from "node:fs"
import * as path from "node:path"
import sharp from "sharp"

export type Dimensions = { width: number; height: number }

/** resize 参数：等比缩到最长边不超过 max，且绝不放大 */
export function fitInside(max: number) {
  return { width: max, height: max, fit: "inside" as const, withoutEnlargement: true }
}

/** 读取图片尺寸，不是合法图片时抛错 */
export async function imageDimensions(file: string): Promise<Dimensions> {
  const meta = await sharp(file).metadata()
  if (!meta.width || !meta.height) {
    throw new Error(`opencode-image: cannot read image dimensions: ${file}`)
  }
  return { width: meta.width, height: meta.height }
}

/** 读取任意图片并按需缩放，统一输出 PNG 字节（用于上传接口，mime 才准确） */
export async function toPngBuffer(source: string, maxSize: number): Promise<Buffer> {
  const current = await imageDimensions(source)
  const pipeline =
    Math.max(current.width, current.height) > maxSize ? sharp(source).resize(fitInside(maxSize)) : sharp(source)
  return pipeline.png().toBuffer()
}

/** 生成等比缩放的 PNG 预览；原图本身不超过 max 时直接返回原图路径 */
export async function renderPreview(source: string, destination: string, max: number): Promise<string> {
  const current = await imageDimensions(source)
  if (Math.max(current.width, current.height) <= max) return source
  await sharp(source).resize(fitInside(max)).png().toFile(destination)
  return destination
}

/**
 * 把接口返回的原始字节归一化为 PNG 落盘：
 * 1. 先写 staging 文件，再从落盘字节读尺寸（避免半截文件被当成成品）
 * 2. 超过 maxSize 时等比缩小
 * 3. 统一转 PNG，保证扩展名、mime 与实际字节一致
 */
export async function persistImage(raw: Buffer, destination: string, maxSize: number): Promise<Dimensions> {
  fs.mkdirSync(path.dirname(destination), { recursive: true })
  const staging = `${destination}.${process.pid}-${Date.now()}.download`
  fs.writeFileSync(staging, raw)
  try {
    const meta = await sharp(staging).metadata()
    const width = meta.width ?? 0
    const height = meta.height ?? 0
    if (!width || !height) throw new Error("opencode-image: response is not a decodable image")
    const pipeline =
      Math.max(width, height) > maxSize ? sharp(staging).resize(fitInside(maxSize)) : sharp(staging)
    await pipeline.png().toFile(destination)
  } finally {
    fs.rmSync(staging, { force: true })
  }
  return imageDimensions(destination)
}

#!/usr/bin/env node
/**
 * 生成 PWA 图标：apple-touch-icon 180、icon-192/512 与 maskable 版本（safe zone 内缩 20%）。
 * 依赖 sharp（devDependency）。核心 SVG 手写：盾形 + 字母 A + 闪电，红色渐变。
 * 用法：node scripts/generate-icons.js
 */
const fs = require('fs')
const path = require('path')
const sharp = require('sharp')

const SVG_ROOT = path.resolve(__dirname, '../public/favicon.svg')

/** maskable 版：图形整体缩到 80% safe zone 内 */
function maskableSvg() {
  const inner = fs.readFileSync(SVG_ROOT, 'utf8')
  const body = inner.replace(/^[\s\S]*?<\/defs>/, '').replace(/<\/svg>\s*$/, '')
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">
  <defs>${inner.match(/<defs>[\s\S]*?<\/defs>/)[0].replace(/<\/?defs>/g, '')}</defs>
  <rect width="64" height="64" fill="#0B0F14"/>
  <g transform="translate(6.4 6.4) scale(0.8)">${body}</g>
</svg>`
}

async function main() {
  const pub = path.resolve(__dirname, '../public')
  const png = (svg, size, name) => sharp(Buffer.from(svg)).resize(size, size).png().toFile(path.join(pub, name))

  await Promise.all([
    png(fs.readFileSync(SVG_ROOT), 180, 'apple-touch-icon.png'),
    png(fs.readFileSync(SVG_ROOT), 192, 'icon-192.png'),
    png(fs.readFileSync(SVG_ROOT), 512, 'icon-512.png'),
    png(maskableSvg(), 192, 'icon-192-maskable.png'),
    png(maskableSvg(), 512, 'icon-512-maskable.png'),
  ])
  console.log('icons generated in public/')
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})

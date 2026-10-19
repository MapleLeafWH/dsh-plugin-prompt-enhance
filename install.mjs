#!/usr/bin/env node
/**
 * 把本插件装进 Desktop 版 DSH 的 profile（默认 desktop）。
 *
 * 等价于 Web UI「插件管理」页的 installBundle 手动版：
 *   1. node_modules/<name> 软链到本目录
 *   2. profile package.json: dependencies[name] = "link:<abs>"，并写进 dsh.profile.bundles
 *   3. 备份原 package.json
 *
 * 顺序是刻意的：先建软链再改 package.json，这样 HMR 一看到 package.json
 * 变化就能立刻解析到这个包。写完等 2~3 秒（HMR 有写稳定延迟），刷新页面即可看到按钮。
 *
 * 用法：
 *   node install.mjs                 # 安装
 *   node install.mjs --dry-run       # 只打印计划
 *   node install.mjs --uninstall     # 卸载（删依赖、bundles 条目、软链）
 *   node install.mjs --profile=web   # 换 profile
 */
import { readFileSync, writeFileSync, existsSync, symlinkSync, unlinkSync, copyFileSync, lstatSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const packageJson = JSON.parse(readFileSync(join(here, 'package.json'), 'utf8'))
const NAME = packageJson.name

const args = process.argv.slice(2)
const dryRun = args.includes('--dry-run')
const uninstall = args.includes('--uninstall')
const profileArg = args.find((arg) => arg.startsWith('--profile='))
const profileName = profileArg ? profileArg.slice('--profile='.length) : 'desktop'

const candidates = [
  process.env.DSH_PROFILE_DIR,
  join(homedir(), '.dsh-beta', 'profiles', profileName),
  join(homedir(), '.dsh', 'profiles', profileName),
].filter(Boolean)
const profileDir = candidates.find((dir) => existsSync(join(dir, 'package.json')))
if (!profileDir) {
  console.error('找不到 profile 目录，试过：\n  ' + candidates.join('\n  '))
  process.exit(1)
}

const manifestPath = join(profileDir, 'package.json')
const linkPath = join(profileDir, 'node_modules', NAME)
const target = resolve(here)
const relativeTarget = relative(dirname(linkPath), target)

function load() {
  return JSON.parse(readFileSync(manifestPath, 'utf8'))
}

function plan(manifest) {
  const deps = manifest.dependencies || {}
  const bundles = (manifest.dsh && manifest.dsh.profile && manifest.dsh.profile.bundles) || []
  return {
    hasDependency: Object.hasOwn(deps, NAME),
    dependencySpec: deps[NAME],
    hasBundle: bundles.includes(NAME),
    linkExists: existsSync(linkPath),
  }
}

const before = plan(load())
console.log('profile  : ' + profileDir)
console.log('package  : ' + target)
console.log('状态     : ' + JSON.stringify(before))

if (uninstall) {
  const manifest = load()
  if (manifest.dependencies) delete manifest.dependencies[NAME]
  if (manifest.dsh && manifest.dsh.profile && Array.isArray(manifest.dsh.profile.bundles)) {
    manifest.dsh.profile.bundles = manifest.dsh.profile.bundles.filter((name) => name !== NAME)
  }
  if (!dryRun) {
    copyFileSync(manifestPath, manifestPath + '.bak-' + timestamp())
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n')
    if (before.linkExists) {
      const stat = lstatSync(linkPath)
      if (stat.isSymbolicLink()) unlinkSync(linkPath)
    }
    console.log('已卸载。等 2~3 秒让 HMR 重算组合，然后刷新页面。')
  } else {
    console.log('[dry-run] 将删除依赖条目、bundles 条目与软链。')
  }
  process.exit(0)
}

if (!before.linkExists) {
  console.log((dryRun ? '[dry-run] ' : '') + '创建软链 ' + linkPath + ' -> ' + relativeTarget)
  if (!dryRun) symlinkSync(relativeTarget, linkPath)
}
if (!before.hasDependency || !before.hasBundle) {
  const manifest = load()
  manifest.dependencies = manifest.dependencies || {}
  manifest.dependencies[NAME] = 'link:' + target
  manifest.dsh = manifest.dsh || {}
  manifest.dsh.profile = manifest.dsh.profile || {}
  manifest.dsh.profile.bundles = manifest.dsh.profile.bundles || []
  if (!manifest.dsh.profile.bundles.includes(NAME)) manifest.dsh.profile.bundles.push(NAME)
  if (!dryRun) {
    copyFileSync(manifestPath, manifestPath + '.bak-' + timestamp())
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n')
    console.log('已写入 profile package.json 并追加 dsh.profile.bundles。')
  } else {
    console.log('[dry-run] 将写入 ' + manifestPath + '（备份为 .bak-<ts>）')
  }
} else {
  console.log('已安装，无需改动。')
}

if (!dryRun) {
  console.log('\n完成。HMR 会在 2~3 秒内重新组合 profile；然后：')
  console.log('  - Host 路由: curl -s http://127.0.0.1:43120/prompt-enhance')
  console.log('  - Client 按钮: 刷新页面（Cmd+R），输入框右侧会出现 ✨')
  console.log('  - 若没生效：Cmd+Q 完全退出再打开；日志在 ~/.dsh-beta/logs/')
}

function timestamp() {
  const now = new Date()
  const pad = (value) => String(value).padStart(2, '0')
  return (
    now.getFullYear() +
    pad(now.getMonth() + 1) +
    pad(now.getDate()) +
    '-' +
    pad(now.getHours()) +
    pad(now.getMinutes()) +
    pad(now.getSeconds())
  )
}

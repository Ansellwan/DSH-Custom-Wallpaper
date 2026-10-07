// 客户端插件契约校验（通用版）。
//
// 读取插件目录，在共享 DOM 桩里加载它真实的 client.js，验证契约与铁律：
// 清单三要素、patch 行 id、factory id、只依赖 react、apply 无异常、
// 插槽注册的 key/id/order/label、组件能渲染、同一插槽 id 不重复、
// 注册了清理函数、卸载不留 <style>、可执行代码不访问未声明的 ctx 服务。
//
// 用法：
//   node check-dsh-plugin.mjs <插件目录>
//   node check-dsh-plugin.mjs <插件目录> --expect-slot settings.section
import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { createHarness } from './dom-harness.mjs'

const args = process.argv.slice(2)
const pluginDirArg = args.find((arg) => !arg.startsWith('--'))
if (pluginDirArg === undefined) {
  console.error('用法：node check-dsh-plugin.mjs <插件目录> [--expect-slot <插槽key>]')
  process.exit(2)
}
const pluginDir = resolve(pluginDirArg)
const expectSlotIndex = args.indexOf('--expect-slot')
const expectSlot = expectSlotIndex === -1 ? undefined : args[expectSlotIndex + 1]

const failures = []
const check = (label, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  if (!ok) failures.push(`${label}: got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`)
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label} -> ${JSON.stringify(actual)}`)
}
const checkThat = (label, condition, detail = '') => {
  if (!condition) failures.push(`${label}${detail === '' ? '' : `: ${detail}`}`)
  console.log(`${condition ? 'ok  ' : 'FAIL'} ${label}${detail === '' ? '' : ` (${detail})`}`)
}

// --- 清单 -------------------------------------------------------------------
const manifestPath = join(pluginDir, 'package.json')
if (!existsSync(manifestPath)) {
  console.error(`错误：${manifestPath} 不存在`)
  process.exit(2)
}
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
const packageName = manifest.name
const patchPath = join(pluginDir, 'cordis.patch.yml')
if (!existsSync(patchPath)) {
  console.error(`错误：${patchPath} 不存在（bundle 需要 patch 层）`)
  process.exit(2)
}
const patchText = readFileSync(patchPath, 'utf8')
const rowId = /-\s*id:\s*([^\s]+)/.exec(patchText)?.[1]
const clientEntry = manifest.exports?.['./client']
const clientRel = typeof clientEntry === 'string' ? clientEntry : clientEntry?.default
const clientPath = clientRel === undefined ? undefined : join(pluginDir, clientRel)

console.log(`插件：${packageName}`)
console.log(`目录：${pluginDir}`)
console.log(`行 id：${rowId ?? '(未在 patch 中找到)'}`)
if (expectSlot !== undefined) console.log(`预期插槽：${expectSlot}`)
console.log('')

checkThat('清单声明了 dsh.bundle.patch', typeof manifest.dsh?.bundle?.patch === 'string')
checkThat('清单声明了 dsh.client.platform', typeof manifest.dsh?.client?.platform === 'string')
checkThat('清单导出了 ./client', clientPath !== undefined && existsSync(clientPath))
checkThat('patch 里有插件行 id', typeof rowId === 'string' && rowId.length > 0)

const source = readFileSync(clientPath, 'utf8')

// --- 桩与环境 ---------------------------------------------------------------
const harness = createHarness({ withColumn: true })

const reactStub = {
  createElement: (type, props, ...children) => ({ type, props, children }),
  useEffect: () => {},
  useRef: () => ({ current: null }),
  useState: (initial) => [initial, () => {}],
  useSyncExternalStore: () => ({}),
  useMemo: (fn) => fn(),
}

let factory = null
let factoryId = null
const extraRequires = []
globalThis.window.__ModuleLoader__ = {
  load(spec) {
    factoryId = spec.id
    factory = spec.factory((name) => {
      if (name === 'react') return reactStub
      extraRequires.push(name)
      throw new Error(`unexpected require: ${name}`)
    })
  },
}

new Function(source)()
checkThat('client.js 注册了 factory', factory !== null)
check('factory id 等于包名', factoryId, packageName)
checkThat('factory 只依赖 react', extraRequires.length === 0, `额外 require：${extraRequires.join(', ') || '无'}`)

// --- 装配上下文并 apply ------------------------------------------------------
const registrations = []
const disposers = []
const ctx = {
  locale: { register: () => () => {}, bind: () => (key) => key },
  effect: (fn) => {
    const disposer = fn()
    if (typeof disposer === 'function') disposers.push(disposer)
  },
  slots: {
    inject: (key, callback) => callback(),
    register: (options, component) => {
      registrations.push({ options, component })
      return () => {}
    },
  },
}

let applyError = null
try {
  factory.apply(ctx)
} catch (error) {
  applyError = error
}
checkThat('apply 无异常', applyError === null, applyError === null ? '' : applyError.message)
harness.flushTimers()

checkThat('注入了 slots', Array.isArray(factory.inject) && factory.inject.includes('slots'))
checkThat('注册了至少一个插槽项', registrations.length > 0, `${registrations.length} 项`)

for (const { options, component } of registrations) {
  checkThat(`插槽项 ${options.name} 带 id`, typeof options.id === 'string' && options.id.length > 0)
  checkThat(`插槽项 ${options.name} 有 order`, typeof options.order === 'number')
  if (expectSlot !== undefined) check('插槽 key 符合预期', options.name, expectSlot)
  const label = typeof options.label === 'function' ? options.label() : options.label
  checkThat(`插槽项 ${options.name} 能给出标题`, typeof label === 'string' && label.length > 0, String(label))
  let rendered = null
  let renderError = null
  try {
    rendered = component({ close: () => {}, t: (key) => key })
  } catch (error) {
    renderError = error
  }
  // 组件可以合法地返回 null（例如控制器起不来时只保留入口），所以只断言"不抛错"。
  checkThat(`组件 ${options.name} 渲染无异常`, renderError === null, renderError?.message ?? '')
}

const cellKeys = registrations.map(({ options }) => `${options.name}#${options.id}`)
checkThat('同一插槽内 id 不重复', new Set(cellKeys).size === cellKeys.length, cellKeys.join(', '))
checkThat('注册了清理函数（ctx.effect）', disposers.length > 0, `${disposers.length} 个`)

// --- 不许劫持应用的全局输入 --------------------------------------------------
// 铁律：**界面插件的默认行为是"不碰"用户的输入**。装饰性插件一旦在 window 上装
// `paste` 监听并且 `preventDefault()`，就会抢走应用自己的功能 ——
// 真实事故：壁纸插件吃掉聊天框里的图片粘贴，用户粘一张图要发给会话，壁纸被换掉、
// 图片也没进输入框。两条互补的检查：
//   ① 行为：焦点不在插件自己的面板里时，派发一个**含图片**的粘贴事件，不该被拦下；
//   ② 静态：全局 `paste` 监听必须带"作用范围判定"，不能无条件吞掉事件。
// 为什么行为检查必须用"图片"：只测纯文本的话，一个"只在剪贴板里是图片时才劫持"的
// 全局监听会照样通过 —— 那正是这次事故的形态（第一版检查就是这么漏掉的）。
const pasteEvents = [
  {
    label: '含图片',
    event: {
      clipboardData: {
        items: [
          {
            kind: 'file',
            type: 'image/png',
            getAsFile: () => ({ type: 'image/png', size: 2048, name: 'pasted.png' }),
          },
        ],
      },
      target: harness.body,
    },
  },
  {
    label: '纯文本',
    event: {
      clipboardData: { items: [{ kind: 'string', type: 'text/plain', getAsFile: () => null }] },
      target: harness.body,
    },
  },
]
for (const { label, event } of pasteEvents) {
  harness.setActive(harness.body) // 焦点在对话输入框（= 不在任何插件面板里）
  const hijacked = harness.dispatch('paste', event)
  checkThat(
    `不劫持全局粘贴（${label}，焦点在应用侧）`,
    hijacked === false,
    hijacked ? 'window 上的 paste 监听把它 preventDefault 了 —— 这会抢走应用自身的粘贴' : '',
  )
}
const codeText = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
// 静态这条只拦"**完全无判定**的全局 paste 监听"：即挂到 window/document，且整段代码里
// 没出现任何"限定作用范围"的痕迹（包含性判定 / 焦点 / 可见性）。加了这些痕迹的监听
// 属于有意图的实现（壁纸插件的 `wallpaperPanel.contains(...)` + `activeElement` 就是），
// 不该被判失败 —— **检查太钝会逼着人忽略它**，那比漏检更糟。
const hasGlobalPaste = /(?:window|document)\s*\.\s*addEventListener\(\s*['"]paste['"]/.test(codeText)
const hasScopeEvidence = /contains\s*\(|activeElement|closest\s*\(|\.matches\s*\(/.test(codeText)
checkThat(
  '全局 paste 监听带有作用范围判定',
  !hasGlobalPaste || hasScopeEvidence,
  hasGlobalPaste && !hasScopeEvidence
    ? '装了全局 paste 监听，却没有任何"事件是否发生在自己面板里"的判定（contains / activeElement / 可见性）'
    : '',
)

// --- 卸载必须干净 ------------------------------------------------------------
for (const dispose of disposers) dispose()
checkThat('卸载后不留 <style>', harness.styleElements().length === 0, `剩 ${harness.styleElements().length} 个`)
checkThat('卸载后没有残留的全局粘贴监听', harness.hasListener('paste') === false, '监听器没摘掉，卸载后会继续影响应用')

// --- 静态检查：铁律 ----------------------------------------------------------
checkThat(
  '没有直接 import Harness Client 包',
  !/require\(\s*['"]@deepseek-ai\/dsh-client-/.test(source),
  'factory 里只允许 require("react")',
)

// cordis 对未声明 inject 的服务是"读属性即抛错"，所以可执行代码里不能出现注入面之外的 ctx.xxx
const codeOnly = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
const touched = [...new Set([...codeOnly.matchAll(/ctx\??\.(\w+)/g)].map((match) => match[1]))]
const declared = new Set([...(factory.inject ?? []), 'effect', 'on', 'inject', 'scope'])
const undeclared = touched.filter((name) => !declared.has(name))
checkThat(
  '不访问未声明的 ctx 服务',
  undeclared.length === 0,
  undeclared.length === 0
    ? `访问了 ${touched.join(', ')}`
    : `未声明却访问：${undeclared.join(', ')}（cordis 会抛 "cannot get property … without inject"）`,
)

console.log(failures.length === 0 ? '\nALL CHECKS PASSED' : `\n${failures.length} CHECK(S) FAILED`)
process.exit(failures.length === 0 ? 0 : 1)

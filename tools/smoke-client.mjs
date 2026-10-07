// 壁纸插件的回归测试：在共享 DOM 桩里加载真实 client.js，覆盖
// 存储、样式表、背景层、设置页注册，以及"关掉后完全恢复原样"。
//
// 历史教训（这几条让本文件长成现在这样）：
//   * 模块在 `new Function` 里求值，DOM 桩必须挂 globalThis，否则插件静默失效；
//   * `ctx.effect` 的 dispose 回调不能在安装阶段调用，否则等于当场把插件拆掉；
//   * 桩不能比现实宽松 —— 曾因桩提供虚构服务而"测试全绿、真机崩溃"；
//   * 第一版壁纸把背景层画在不透明 body 之下、又被实色对话根容器挡住，
//     表现为"选了图但屏幕没变化"，所以下面把可见性 CSS 与级联优先级固定成断言。
//
// 用法：node smoke-client.mjs <client.js 路径>
import { readFileSync } from 'node:fs'
import { createHarness } from './dom-harness.mjs'

const source = readFileSync(process.argv[2], 'utf8')

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

/** 组件里 useRef 拿到的对象；粘贴面板与文件输入都靠它。每次渲染前清空再收集。 */
const refs = []
const reactStub = {
  createElement: (type, props, ...children) => ({ type, props, children }),
  useEffect: () => {},
  useRef: () => {
    const ref = { current: null }
    refs.push(ref)
    return ref
  },
  useState: (initial) => [initial, () => {}],
  // 真实 hook 会给出当前快照；桩返回空对象会让组件拿到 undefined 的设置而崩溃，
  // 那是桩太薄，不是插件的问题。
  useSyncExternalStore: (_subscribe, getSnapshot) => getSnapshot(),
  useMemo: (fn) => fn(),
}

/** 每次加载都用一套全新桩，模拟一次页面启动。 */
const loadBundle = (harness) => {
  let factory = null
  globalThis.window.__ModuleLoader__ = {
    load(spec) {
      factory = spec.factory((name) => {
        if (name === 'react') return reactStub
        throw new Error(`unexpected require: ${name}`)
      })
    },
  }
  new Function(source)()
  return factory
}

const registrations = []
const disposers = []
const makeCtx = () => ({
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
})

// --- 第一次加载：注册、默认值、样式表 ---------------------------------------
const harness = createHarness({ withColumn: true })
const first = loadBundle(harness)
check('factory id resolved', first !== null, true)
check('inject face', first.inject, ['slots', 'locale'])
first.apply(makeCtx())

check('slot key', registrations[0]?.options.name, 'settings.section')
check('slot id', registrations[0]?.options.id, 'wallpaper')
check('slot order', registrations[0]?.options.order, 60)
check('slot label', registrations[0]?.options.label(), 'section.nav')
check('component renders element', typeof registrations[0]?.component(), 'object')
check('no write on first paint', harness.store.has('dsh.ui-wallpaper/v1'), false)
// 两个 ctx.effect：卸载复原（层/样式/标记/变量/面板引用）与粘贴监听。
// 数错了会掩盖"少注册了清理函数"这类问题，所以这里写死并附上说明。
check('teardown registered, not run', disposers.length, 2)

// 注册项本身只是"外层工厂"，它的返回值才是真正的页面组件；不把内层函数也调一次，
// 页面里的 hook（useRef 等）根本不会执行。这个坑值得记一笔：注册项能渲染 ≠ 页面跑过。
const renderedNode = registrations[0]?.component({ t: (key) => key })
check('slot factory returns the page element', typeof renderedNode?.type, 'function')
const refsAfterFactory = refs.length
refs.length = 0
const pageNode = renderedNode.type(renderedNode.props)
check('page render returns the panel element', pageNode?.props?.className, 'wlp-page')
checkThat('panel host binds a ref callback', typeof pageNode?.props?.ref, 'function')
check('page render allocated a ref for the file input', refs.length, 1)
check('outer factory runs no page hooks', refsAfterFactory, 0)

// 真实 DOM 会拿真实节点回填 ref 回调；桩不会，所以这里按 React 的语义补上这一步 ——
// 这不是"替插件写代码"，而是把宿主环境该做的事做出来。面板节点用真实桩节点并挂进
// document，这样 `contains()` 与矩形判定才和浏览器一致。
const panel = harness.body.appendChild(harness.document.createElement('div'))
panel.className = 'wlp-page'
pageNode.props.ref(panel)

// 兜底入口必须在：键盘粘贴读不到剪贴板时，用户得有个明确可点的东西。
const collect = (node, out = []) => {
  if (node === null || node === undefined || typeof node !== 'object') return out
  out.push(node)
  for (const child of node.children ?? []) collect(child, out)
  return out
}
const buttons = collect(pageNode).filter((node) => node.type === 'button')
checkThat('settings page offers a remove-wallpaper button', buttons.length >= 1, `${buttons.length} 个按钮`)
checkThat(
  'panel host is programmatically focusable',
  pageNode?.props?.tabIndex === -1,
  '粘贴闸门认焦点，宿主必须能被脚本聚焦（tabIndex=-1）',
)

const styleNode = harness.findById('dsh-wallpaper-style')
checkThat('stylesheet survives activation', styleNode !== null)
checkThat('stylesheet landed in <head>', harness.head.children.includes(styleNode))

// 可见性规则与级联优先级：壁纸靠这些规则才能透出来，且必须压过其它插件
// 往同一批元素上写的 background（同级选择器 + 后出现的样式表会反超）。
for (const rule of [
  'html[data-dsh-wallpaper="active"]',
  'background-color: transparent !important',
  '[class*="_frame"]',
  '[class*="_sidebarCol"]',
  '[class*="_centerCol"]',
  '[class*="_rightbarCol"]',
  '[class*="_root"]',
]) {
  checkThat(`bundle source keeps ${rule}`, source.includes(rule))
}
// 注意：源码里这条声明是**换行书写**的（`var(--dsh-alias-bg-base)` 与 `var(--wlp-surface,` 不在同一行），
// 所以断言不能拿连写的字符串去匹配——用正则容忍空白。
checkThat(
  'tint rule mixes the base color with the surface variable',
  /color-mix\(in srgb, var\(--dsw-alias-bg-base\)\s+var\(--wlp-surface,/.test(source),
)
checkThat(
  'sidebar tint keeps its own fill token',
  /var\(--dsw-specific-sidebar-fill, var\(--dsw-alias-bg-base\)\)\s+var\(--wlp-surface,/.test(source),
)
checkThat(
  'layer keeps a negative z-index',
  source.includes('#${LAYER_ID} {') && source.includes('z-index: -1'),
  'the backdrop must paint below the app frame',
)

// ⭐ 通透度变量的"声明位置"本身是回归点：**任何中间层都不许声明 --wlp-surface**。
// 元素自己声明的值会压过继承值，所以 body 上一旦有默认声明，根元素上的内联值就永远
// 传不到列上 —— 现象是"滑杆拖了没反应、界面看着不够通透"，而且改样式、看代码都正常，
// 极难定位。这里直接在源码层面把它钉死。
// 注意：**先剥掉 CSS 注释再判定**。本次就吃过亏：注释里举的反例
// （`body { --wlp-surface: … }`）被这条检查当成了真声明，于是它对着正确代码也报红。
const cssBlock = (/style\.textContent = `([\s\S]*?)`/.exec(source)?.[1] ?? '').replace(/\/\*[\s\S]*?\*\//g, '')
const surfaceDeclarations = [...cssBlock.matchAll(/(^|\})\s*([^{}]*?)\{([^{}]*--wlp-surface\s*:[^{}]*)\}/g)].map(
  (match) => `${match[2].trim()} { ${match[3].trim()} }`,
)
check('no stylesheet layer declares --wlp-surface itself', surfaceDeclarations, [])
checkThat(
  'the surface variable is only set inline on the root',
  /setProperty\('--wlp-surface'/.test(source) && source.includes('root.style.setProperty'),
  '唯一写值的地方应是根元素的内联样式',
)
checkThat(
  'the fallback lives on the read side',
  cssBlock.includes('var(--wlp-surface, ${DEFAULT_SURFACE}%)'),
  '兜底必须写成 var() 的回退值，而不是某个层上的默认声明',
)

// --- 无图：不建层，标记为 inactive ------------------------------------------
check('inactive marker without an image', harness.html.getAttribute('data-dsh-wallpaper'), 'inactive')
check('no layer without an image', harness.findById('dsh-wallpaper-layer'), null)

// --- 粘贴闸门：聊天框里的 Ctrl+V 绝不能被壁纸插件吃掉 ------------------------
// 真实事故（2026-10-05）：插件在 window 上装了全局 paste 监听，只要剪贴板里有图就
// preventDefault 并写进壁纸设置 —— 用户在对话框里粘一张图发给会话，壁纸当场被换掉，
// 而且那张图也没进输入框。断言分两种情形：焦点不在面板里（必须完全不管），
// 焦点在面板里（才允许接管）。**必须在这一轮 apply 之后测**：组件渲染会把面板 ref 交给
// 插件，而下一轮 apply 会重新指向新控制器。
// 焦点在面板上之前，先确认"刚装好、没粘过图"的基线。
const imageOf = (h) => (JSON.parse(h.store.get('dsh.ui-wallpaper/v1') ?? '{}').image ?? '')
const gateOf = (h) => JSON.parse(h.store.get('dsh.ui-wallpaper/paste-gate') ?? '{}')
const clipboardImage = () => ({
  clipboardData: {
    items: [
      {
        kind: 'file',
        type: 'image/png',
        getAsFile: () => ({ type: 'image/png', size: 1234, dataUrl: 'data:image/png;base64,PASTED' }),
      },
    ],
  },
})

// 1) 面板开着、但用户不是冲壁纸来的（焦点在对话输入框）：插件必须完全不插手。
//    这是原事故的现场：面板可能还挂在文档里（矩形非空），只有"焦点不在面板内"能识别出来。
harness.setActive(harness.body)
check('baseline wallpaper image', imageOf(harness), '')
const swallowed = harness.dispatch('paste', clipboardImage())
check('chat paste is left alone (not preventDefault-ed)', swallowed, false)
check('chat paste does not touch the wallpaper', imageOf(harness), '')
check('chat paste is recorded as ignored', gateOf(harness).handled, false)
check('chat paste records focus-elsewhere', gateOf(harness).reason, 'panel-open-focus-elsewhere')

// 2) 焦点在壁纸面板内部（用户先点了面板、或面板挂载时自己收了焦点）：这时候才该接管。
//    图片要经过 FileReader → Image → canvas 编码，是真异步的；把微任务队列排空再断言，
//    否则测的是"还没来得及写"的中间态（这个坑第一次就踩了）。
//    注意**不能用 setTimeout 等待**：桩把全局 setTimeout 换成了自己的队列（那是必要的，
//    否则插件里的延时逻辑会真的拖慢测试），于是这里只能靠微任务边界推进。
harness.setActive(panel)
const claimed = harness.dispatch('paste', clipboardImage())
check('panel paste is claimed', claimed, true)
await null
await null
await null
checkThat('panel paste reaches the wallpaper', imageOf(harness).startsWith('data:image/'), `image=${imageOf(harness)}`)
check('panel paste records the gate', gateOf(harness).reason, 'panel-focused')
check('panel paste records that it handled', gateOf(harness).handled, true)

// 3) 纯文本粘贴：剪贴板里没有图，就不该被接管（用户可能往壁纸页的输入框里粘路径之类）。
const textOnly = { clipboardData: { items: [{ kind: 'string', type: 'text/plain', getAsFile: () => null }] } }
harness.setActive(panel)
check('text-only paste is not claimed', harness.dispatch('paste', textOnly), false)
check('text-only paste leaves the wallpaper alone', imageOf(harness).startsWith('data:image/'), true)

// 4) 焦点离开面板（用户关掉设置窗、回到对话框）：不许接管。
//    只断言"行为"与"设置没被改"：诊断文案（panel-open / hidden 的区分）依赖宿主怎么隐藏
//    面板，属于观测细节，不该把测试绑死在它上面。
const imageBeforeLeaving = imageOf(harness)
harness.setActive(harness.body)
check('paste after leaving the panel is not claimed', harness.dispatch('paste', clipboardImage()), false)
check('paste after leaving the panel changes nothing', imageOf(harness), imageBeforeLeaving)
check('leaving the panel is recorded as ignored', gateOf(harness).handled, false)

// 5) 焦点在面板的**子节点**上（用户点了某个滑杆）：包含判定要认后代，仍然算"在面板里"。
const slider = harness.document.createElement('input')
panel.appendChild(slider)
harness.setActive(slider)
check('focus inside a panel child is claimed', harness.dispatch('paste', clipboardImage()), true)
await null
await null
await null
check('focus inside a panel child records the gate', gateOf(harness).reason, 'panel-focused')

// 6) 面板卸载（ref 回调收到 null）之后，即使在"面板位置"粘贴也不该再接管。
pageNode.props.ref(null)
harness.setActive(panel)
check('paste after unmount is not claimed', harness.dispatch('paste', clipboardImage()), false)
check('unmounted panel is recorded', gateOf(harness).reason, 'no-panel')

// --- 有图：下一次加载画出可见的层 -------------------------------------------
harness.store.set(
  'dsh.ui-wallpaper/v1',
  JSON.stringify({
    enabled: true,
    image: 'data:image/png;base64,AAAA',
    fit: 'cover',
    opacity: 90,
    surface: 40,
    blur: 6,
    dim: 20,
    scrim: 40,
    scrimBlur: 12,
    saturate: 80,
  }),
)
const second = loadBundle(harness)
second.apply(makeCtx())

// 桩不算 CSS 级联，所以"实测出来的值"要显式喂进去。这里刻意布置一个**假想的遮挡层**：
// 只有把"谁在挡着壁纸"真实地摆出来，才能验证插件报的是观测值而不是意图值。
harness.setComputed(harness.column, { backgroundColor: 'rgba(21, 21, 23, 0.4)', pointerEvents: 'auto' })
// 桩不做 CSS 继承：真实浏览器里列会从根元素继承 --wlp-surface，桩必须显式声明这一点。
harness.setComputed(harness.column, { '--wlp-surface': harness.html.style.getPropertyValue('--wlp-surface') })
harness.setComputed(harness.html, { pointerEvents: 'auto' })
harness.setComputed(harness.body, { backgroundColor: 'rgba(0, 0, 0, 0)', pointerEvents: 'auto' })
const opaqueChild = harness.document.createElement('div')
opaqueChild.className = 'StubHash_message'
harness.column.appendChild(opaqueChild)
harness.setComputed(opaqueChild, { backgroundColor: 'rgb(21, 21, 23)', pointerEvents: 'auto' })
second.apply(makeCtx())

const layer = harness.findById('dsh-wallpaper-layer')
checkThat('layer created for a stored image', layer !== null)
check('active marker with an image', harness.html.getAttribute('data-dsh-wallpaper'), 'active')
// 注意用 checkThat：`check(label, actual, expected)` 比的是 JSON，传布尔真值会误判。
checkThat('layer sits first inside body', harness.body.children[0] === layer, `body 顺序：${harness.body.children.map((node) => node.id || node.className || node.nodeName).join(', ')}`)
check('layer paints the image', layer?.style.backgroundImage, 'url("data:image/png;base64,AAAA")')
check('opacity comes from settings', layer?.style.opacity, '0.9')
check('blur reaches the layer', layer?.style.getPropertyValue('--wlp-blur'), '6px')

// --- 薄纱层（治"眼睛累"的那一层）---------------------------------------------
// 它必须**在图片之上、界面之下**（同为负 z-index，按 DOM 顺序叠放），并且两个作用都要
// 落到它身上：rgba 底色托住对比度下限、backdrop-filter 把高频细节抹平。层级搞反会挡住整屏。
const scrim = harness.findById('dsh-wallpaper-scrim')
checkThat('scrim layer created with an image', scrim !== null)
// 判"薄纱在图片之后"，而不是"它是 body 的第 2 个孩子"——测试自己往 body 里塞过面板，
// 那个下标会随测试步骤漂移。要钉的是 DOM 相对顺序。
const layerIndex = harness.body.children.indexOf(layer)
checkThat(
  'scrim sits directly after the image layer',
  harness.body.children[layerIndex + 1] === scrim,
  `body 顺序：${harness.body.children.map((node) => node.id || node.className || node.nodeName).join(', ')}`,
)
checkThat(
  'image is at z-index -2 and scrim at -1 (both behind the app)',
  /#\$\{LAYER_ID\} \{[\s\S]*?z-index: -2;/.test(source) && /#\$\{SCRIM_ID\} \{[\s\S]*?z-index: -1;/.test(source),
)
checkThat(
  'scrim uses a translucent colour plus a backdrop blur',
  /#\$\{SCRIM_ID\} \{[\s\S]*?background: rgba\(var\(--wlp-scrim-rgb[\s\S]*?backdrop-filter: blur\(var\(--wlp-scrim-blur/.test(source),
  '底色提下限 + 虚化抹细节，缺一都治不了"花"',
)
check('scrim strength reaches the layer', scrim?.style.getPropertyValue('--wlp-scrim'), '0.4')
check('scrim blur reaches the layer', scrim?.style.getPropertyValue('--wlp-scrim-blur'), '12px')
check('saturation reaches the root', harness.html.style.getPropertyValue('--wlp-saturate'), '0.8')
checkThat(
  'image filter combines blur and saturation',
  /filter: blur\(var\(--wlp-blur, 0px\)\) saturate\(var\(--wlp-saturate, 1\)\)/.test(source),
)

// 通透度变量必须写在根元素：它要被各列的规则读到，而其它插件可能在 body 上
// 写自己的自定义属性。写在根上才不会被就地覆盖。
check('surface variable lives on the root', harness.html.style.getPropertyValue('--wlp-surface'), '40%')
check('surface variable is not written to body', harness.body.style.getPropertyValue('--wlp-surface'), '')

// 自检指纹：会话能从 localStorage 里读到"实际算出来的值"，而不仅是意图值。
const fingerprint = harness.store.get('dsh.ui-wallpaper/fingerprint')
checkThat('fingerprint recorded', typeof fingerprint === 'string' && fingerprint.length > 0)
const parsed = JSON.parse(fingerprint ?? '{}')
check('fingerprint sees the live layer', parsed.layerPresent, true)
check('fingerprint sees the live surface variable', parsed.surfaceVariableOnRoot, '40%')
// "不通透"排查靠这三项：变量有没有继承到列上、列的实测底色、以及**谁在挡着壁纸**。
check('fingerprint sees the variable on the column', parsed.surfaceVariableOnColumn, '40%')
checkThat('fingerprint samples the layer stack', parsed.stack !== null && Array.isArray(parsed.stack.topDown))
checkThat(
  'fingerprint names the opaque blockers',
  Array.isArray(parsed.stack?.opaqueBlockers) && parsed.stack.opaqueBlockers.includes('.StubHash_message'),
  `opaque=${JSON.stringify(parsed.stack?.opaqueBlockers)}`,
)
checkThat(
  'fingerprint reports the tinted layer with its alpha',
  (parsed.stack?.tintedBlockers ?? []).some((entry) => entry.includes('0.4')),
  `tinted=${JSON.stringify(parsed.stack?.tintedBlockers)}`,
)
checkThat(
  'fingerprint describes the column path',
  typeof parsed.columnPath === 'string' && parsed.columnPath.includes('_centerCol'),
  parsed.columnPath ?? '(null)',
)

// --- 卸载恢复原样 ------------------------------------------------------------
for (const dispose of disposers) dispose()
check('teardown drops the layer', harness.findById('dsh-wallpaper-layer'), null)
check('teardown drops the scrim', harness.findById('dsh-wallpaper-scrim'), null)
check('teardown drops the stylesheet', harness.findById('dsh-wallpaper-style'), null)
check('teardown clears the marker', harness.html.getAttribute('data-dsh-wallpaper'), null)
check('teardown clears the surface variable', harness.html.style.getPropertyValue('--wlp-surface'), '')
check('teardown clears the saturation variable', harness.html.style.getPropertyValue('--wlp-saturate'), '')
check('teardown removes the paste listener', harness.hasListener('paste'), false)

// --- 坏数据降级到默认值 ------------------------------------------------------
for (const dispose of disposers.splice(0)) dispose()
const broken = createHarness({ withColumn: true })
broken.store.set('dsh.ui-wallpaper/v1', '{ not json')
const third = loadBundle(broken)
third.apply(makeCtx())
check('malformed storage degrades to defaults', broken.html.getAttribute('data-dsh-wallpaper'), 'inactive')
check('malformed storage leaves no layer', broken.findById('dsh-wallpaper-layer'), null)
checkThat('malformed storage still installs the stylesheet', broken.findById('dsh-wallpaper-style') !== null)

console.log(failures.length === 0 ? '\nALL CHECKS PASSED' : `\n${failures.length} CHECK(S) FAILED`)
process.exit(failures.length === 0 ? 0 : 1)

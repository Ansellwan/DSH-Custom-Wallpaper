// DSH 客户端插件的 DOM 桩（供 check-dsh-plugin.mjs / smoke-client.mjs 复用）。
//
// 教训（每一条都是真踩过的）：
//   1. 桩要挂在 globalThis 上：插件在 `new Function` 里求值，看不见模块作用域变量，
//      挂错地方的表现是"插件静默什么都不做"；
//   2. `ctx.effect` 的 dispose 回调不能在安装阶段调用，否则等于当场把插件拆掉；
//   3. 桩不能比现实宽松：曾经给排版插件提供了一个真实环境并不存在的 `styles` 服务，
//      结果测试全绿、真机崩溃；
//   4. 浏览器常规 API（setTimeout / requestAnimationFrame / getComputedStyle / CSS.supports）
//      都得在，否则插件正常代码会被误判为失败；
//   5. 事件必须能"派发"（`window.dispatch('paste', event)`），焦点必须能设置
//      （`harness.setActive(node)`）：只在源码里看到 addEventListener 不算验证，
//      必须能把事件喂进去、看它到底做了什么。壁纸插件曾因全局粘贴监听劫持聊天框的
//      图片粘贴，就是靠这条断言出来的。
//
// 使用：install({ bodyBackground, centerColumn, computed }) 后，从 globalThis 读取
// document / window / localStorage；元素用 elementById(id) 或 styleElements() 取用。
export function createHarness(options = {}) {
  const { withColumn = false, computed = {} } = options
  const store = new Map()
  const styleProps = new WeakMap()
  const computedByNode = new WeakMap()
  const listeners = new Map()
  let activeElement = null

  const makeInlineStyle = () => {
    const props = new Map()
    return {
      get textContent() {
        return props.get('__text') ?? ''
      },
      set textContent(value) {
        props.set('__text', value)
      },
      setProperty: (name, value) => props.set(name, value),
      removeProperty: (name) => props.delete(name),
      getPropertyValue: (name) => props.get(name) ?? '',
      set backgroundImage(value) {
        props.set('background-image', value)
      },
      get backgroundImage() {
        return props.get('background-image') ?? ''
      },
      set background(value) {
        props.set('background', value)
      },
      get background() {
        return props.get('background') ?? ''
      },
      set opacity(value) {
        props.set('opacity', value)
      },
      get opacity() {
        return props.get('opacity') ?? ''
      },
      set filter(value) {
        props.set('filter', value)
      },
      get filter() {
        return props.get('filter') ?? ''
      },
    }
  }

  const makeElement = (tag) => {
    const attributes = new Map()
    const element = {
      tagName: String(tag).toUpperCase(),
      nodeName: String(tag).toUpperCase(),
      id: '',
      className: '',
      textContent: '',
      style: makeInlineStyle(),
      attributes,
      children: [],
      parent: null,
      get parentNode() {
        return element.parent
      },
      // 兄弟节点是**标准属性**，插件很自然地会用它们来定位插入位置（本次薄纱层就用
      // `layer.nextSibling`）。桩缺了它不会报错，只会让 `nextSibling` 得到 `undefined`，
      // 于是插件静默走进"追加到末尾"的分支 —— **假失败/假通过都来自这种缺失**。
      get nextSibling() {
        if (element.parent === null) return null
        const index = element.parent.children.indexOf(element)
        return index < 0 || index + 1 >= element.parent.children.length ? null : element.parent.children[index + 1]
      },
      get previousSibling() {
        if (element.parent === null) return null
        const index = element.parent.children.indexOf(element)
        return index <= 0 ? null : element.parent.children[index - 1]
      },
      setAttribute(name, value) {
        attributes.set(name, String(value))
      },
      getAttribute(name) {
        return attributes.has(name) ? attributes.get(name) : null
      },
      removeAttribute(name) {
        attributes.delete(name)
      },
      appendChild(child) {
        child.parent = element
        element.children.push(child)
        return child
      },
      prepend(child) {
        child.parent = element
        element.children.unshift(child)
        return child
      },
      insertBefore(child, reference) {
        child.parent = element
        const index = reference === null || reference === undefined ? -1 : element.children.indexOf(reference)
        if (index < 0) element.children.push(child)
        else element.children.splice(index, 0, child)
        return child
      },
      remove() {
        if (element.parent === null) return
        const index = element.parent.children.indexOf(element)
        if (index >= 0) element.parent.children.splice(index, 1)
        // 焦点元素被移除后，真实浏览器的 activeElement 会退回到 body；
        // 不模拟这一步，就会把"插件已经卸载"误读成"面板还在焦点里"。
        if (activeElement === element) activeElement = body
        element.parent = null
      },
      /** 真实节点接口；`contains` 是所有"事件是否发生在这个面板里"判定的基础。 */
      contains(node) {
        for (let current = node; current !== null && current !== undefined; current = current.parent) {
          if (current === element) return true
        }
        return false
      },
      focus() {
        activeElement = element
      },
      /** 桩里的元素默认"可见"：未挂到文档上的孤立节点没有连接，就不该算可见。 */
      getBoundingClientRect: () => {
        let connected = false
        for (let current = element; current !== null && current !== undefined; current = current.parent) {
          if (current === html) connected = true
        }
        return connected
          ? { x: 0, y: 0, top: 0, left: 0, width: 1200, height: 800, right: 1200, bottom: 800 }
          : { x: 0, y: 0, top: 0, left: 0, width: 0, height: 0, right: 0, bottom: 0 }
      },
      querySelector: () => null,
      querySelectorAll: () => [],
    }
    styleProps.set(element, element.style)
    return element
  }

  const html = makeElement('html')
  const head = makeElement('head')
  const body = makeElement('body')
  html.appendChild(head)
  html.appendChild(body)

  // 可选的对话列，让 `[class*="_centerCol"]` 之类的选择器能查到东西。
  const column = withColumn ? makeElement('div') : null
  if (column !== null) {
    column.className = 'StubHash_centerCol'
    column.classList = { contains: (token) => column.className.includes(token) }
    body.appendChild(column)
  }

  const findById = (node, id) => {
    for (const child of node.children) {
      if (child.id === id) return child
      const found = findById(child, id)
      if (found !== null) return found
    }
    return null
  }

  const documentStub = {
    documentElement: html,
    head,
    body,
    createElement: (tag) => makeElement(tag),
    getElementById: (id) => findById(html, id),
    querySelector: (selector) => (selector.includes('_centerCol') ? column : null),
    querySelectorAll: (selector) => (selector.includes('_centerCol') && column !== null ? [column] : []),
    addEventListener() {},
    removeEventListener() {},
    get activeElement() {
      return activeElement
    },
    /**
     * 命中测试：返回该点上的元素，从最上层往下。
     * 桩里"后加入文档的在上层"（够复现"谁盖住谁"的判定），并且**跳过
     * `pointer-events: none` 的节点** —— 壁纸层就是这种节点，真实浏览器不会命中它。
     */
    elementsFromPoint: () => {
      const collected = []
      const walk = (node) => {
        for (const child of node.children) {
          walk(child)
          collected.push(child)
        }
      }
      walk(html)
      return collected
        .filter((node) => styleProps.get(node)?.getPropertyValue('pointer-events') !== 'none')
        .reverse()
    },
  }
  globalThis.document = documentStub

  globalThis.localStorage = {
    getItem: (key) => (store.has(key) ? store.get(key) : null),
    setItem: (key, value) => store.set(key, String(value)),
    removeItem: (key) => store.delete(key),
  }

  const scheduled = []
  let timerId = 0
  const schedule = (callback) => {
    timerId += 1
    scheduled.push({ id: timerId, callback })
    return timerId
  }
  const cancel = (id) => {
    const index = scheduled.findIndex((entry) => entry.id === id)
    if (index >= 0) scheduled.splice(index, 1)
  }

  globalThis.window = {
    localStorage: globalThis.localStorage,
    innerWidth: 1200,
    innerHeight: 800,
    addEventListener: (type, listener) => {
      if (!listeners.has(type)) listeners.set(type, [])
      listeners.get(type).push(listener)
    },
    removeEventListener: (type, listener) => {
      const bucket = listeners.get(type)
      if (bucket === undefined) return
      const index = bucket.indexOf(listener)
      if (index >= 0) bucket.splice(index, 1)
    },
    setTimeout: schedule,
    clearTimeout: cancel,
    setInterval: schedule,
    clearInterval: cancel,
    requestAnimationFrame: (callback) => schedule(() => callback(0)),
    cancelAnimationFrame: cancel,
  }
  globalThis.setTimeout = schedule
  globalThis.clearTimeout = cancel
  globalThis.CSS = { supports: () => true }

  // 图片解码链（选择文件 → FileReader → Image → canvas）：桩必须能让这条链**真的跑完**，
  // 否则"粘贴后壁纸是否被改写"根本观察不到，断言只能停留在"源码里有 addEventListener"。
  globalThis.FileReader = class FileReader {
    readAsDataURL(file) {
      // 真实 FileReader 是异步的，但桩同步回调即可：测试用 await 兼容两种时序。
      this.result = file?.dataUrl ?? 'data:image/png;base64,STUB'
      this.onload?.()
    }
  }
  globalThis.Image = class Image {
    set src(value) {
      this._src = value
      this.naturalWidth = 1600
      this.naturalHeight = 900
      this.onload?.()
    }
    get src() {
      return this._src
    }
  }
  globalThis.HTMLCanvasElement = class HTMLCanvasElement {}
  documentStub.createElement = (tag) => {
    const element = makeElement(tag)
    if (String(tag).toLowerCase() !== 'canvas') return element
    element.width = 0
    element.height = 0
    element.getContext = () => ({ drawImage() {} })
    element.toDataURL = () => `data:image/png;base64,ENCODED_${element.width}x${element.height}`
    return element
  }

  // getComputedStyle 是"观测值"通道：插件用它自检实际生效的样式，
  // 桩必须给出一个可预测的答案，而不是让它抛错。
  //
  // 注意：桩**不算级联**。"这条规则最终算出来什么颜色"要靠 `setComputed(node, ...)` 显式喂进来
  // ——那正是测试要固定的东西（想验证的结论不能由桩自己推出来）。
  globalThis.getComputedStyle = (element) => {
    const inline = styleProps.get(element) ?? element?.style ?? {}
    const overrides = computedByNode.get(element) ?? {}
    return {
      opacity: overrides.opacity ?? inline.opacity ?? computed.opacity ?? '1',
      filter: overrides.filter ?? inline.filter ?? computed.filter ?? 'none',
      backgroundColor: overrides.backgroundColor ?? inline.backgroundColor ?? computed.backgroundColor ?? 'rgba(0, 0, 0, 0)',
      backgroundImage: overrides.backgroundImage ?? inline.backgroundImage ?? computed.backgroundImage ?? 'none',
      zIndex: overrides.zIndex ?? computed.zIndex ?? 'auto',
      getPropertyValue: (name) => {
        if (overrides[name] !== undefined) return overrides[name]
        return inline.getPropertyValue?.(name) ?? computed[name] ?? ''
      },
    }
  }

  return {
    document: documentStub,
    html,
    head,
    body,
    column,
    store,
    scheduled,
    /**
     * 声明某个节点"实测"出来的计算样式（桩不做级联，所以要显式给）。
     * @param node - 目标节点。
     * @param values - 形如 { backgroundColor, pointerEvents, ... }。
     */
    setComputed: (node, values) => {
      computedByNode.set(node, { ...(computedByNode.get(node) ?? {}), ...values })
      const inline = styleProps.get(node)
      if (inline !== undefined) {
        if (values.pointerEvents !== undefined) inline.setProperty('pointer-events', values.pointerEvents)
        if (values.backgroundColor !== undefined) {
          inline.setProperty('background-color', values.backgroundColor)
          inline.backgroundColor = values.backgroundColor
        }
        if (values.backgroundImage !== undefined) inline.backgroundImage = values.backgroundImage
      }
    },
    /**
     * 把焦点放到某个节点上（等价于用户点了它）。
     * 只有**在文档里的**节点能拿到焦点：真实浏览器里焦点不会停留在已脱离文档的元素上，
     * 桩如果允许，就会把"用户早已关掉设置窗"误判成"焦点还在面板里"。
     */
    setActive: (node) => {
      let connected = false
      for (let current = node; current !== null && current !== undefined; current = current.parent) {
        if (current === html) connected = true
      }
      activeElement = connected ? node : body
    },
    /**
     * 派发一个 window 级事件（paste / drag 等），返回是否被 `preventDefault` 吃掉。
     * 事件对象由调用方给：桩不该替插件决定 `clipboardData` 长什么样。
     */
    dispatch: (type, event) => {
      const payload = { type, defaultPrevented: false, preventDefault: () => { payload.defaultPrevented = true }, ...event }
      for (const listener of listeners.get(type) ?? []) listener(payload)
      return payload.defaultPrevented
    },
    /** 取出所有 <style> 节点（按插入顺序）。 */
    styleElements: () =>
      [...head.children, ...body.children].filter((node) => node.nodeName === 'STYLE'),
    /** 某个 window 事件还有没有监听者（用来验证卸载真的摘掉了监听）。 */
    hasListener: (type) => (listeners.get(type)?.length ?? 0) > 0,
    findById: (id) => findById(html, id),
    /** 运行安装阶段安排的所有定时器（异步上报之类）。 */
    flushTimers: () => {
      const pending = scheduled.splice(0)
      for (const entry of pending) {
        try {
          entry.callback()
        } catch (error) {
          console.log(`    （定时器回调抛出，已忽略：${error.message}）`)
        }
      }
    },
  }
}

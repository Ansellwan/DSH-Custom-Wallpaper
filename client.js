/**
 * Client half of the custom wallpaper bundle.
 *
 * Paints a backdrop layer behind the whole frame and contributes the wallpaper
 * page to Settings. Every preference lives in this page's own storage, so the
 * plugin needs no Host state: `localStorage` carries the scalar preferences and
 * the image is kept as a data URL beside them.
 */
window.__ModuleLoader__.load({
  id: 'dsh-ui-wallpaper',
  factory(require) {
    const VERSION = '1.0.5'
    const React = require('react')
    const h = React.createElement
    const { useEffect, useRef, useState, useSyncExternalStore, useMemo } = React

    /* ------------------------------------------------------------------ *
     * Storage
     * ------------------------------------------------------------------ */

    const STORAGE_KEY = 'dsh.ui-wallpaper/v1'
    /** 应用后 DOM 实测指纹的落盘位置；只用于离线排查。 */
    const FINGERPRINT_KEY = 'dsh.ui-wallpaper/fingerprint'
    /** 粘贴闸门每次判定结果的落盘位置；只用于离线排查。 */
    const GATE_KEY = 'dsh.ui-wallpaper/paste-gate'
    const LAYER_ID = 'dsh-wallpaper-layer'
    const STYLE_ID = 'dsh-wallpaper-style'
    const SCRIM_ID = 'dsh-wallpaper-scrim'
    const MAX_EDGE = 2560
    /**
     * 界面通透度的默认值（%）。只作为 `var()` 的**读取侧兜底**使用。
     *
     * 注意这个名字的意思是"读不到变量时用多少"，**不要**把它写成
     * `body { --wlp-surface: … }` 这类声明 —— 元素自己声明的值会压过继承值，
     * 一旦在中间层声明，根元素上的内联值就再也传不到列上（真踩过，滑杆会静默失灵）。
     */
    const DEFAULT_SURFACE = 34

    const FIT_MODES = ['cover', 'contain', 'tile', 'center']

    /**
     * 挡在壁纸与界面之间的那层"薄纱"（scrim）。
     *
     * 存在的理由（实测数据，不是审美偏好）：一张暗且花、饱和度高的壁纸直接铺在
     * 近乎全透的界面下，浅色文字的对比度会掉到 3:1 出头（正文门槛约 4.5:1），
     * 而且相邻区域的亮度落差大，找字很费眼。薄纱同时压两件事：
     *   - `scrim`：整体提一点底，把对比度的"下限"托起来；
     *   - `scrimBlur`：**虚化壁纸的细节**（backdrop-filter），这是治"花"的关键 ——
     *     单纯调暗只是让整张图变闷，虚化才是把高频细节抹平、让文字重新有干净的底。
     * 它盖的是整块画布（含界面面板背后），所以连各列透出来的部分也一起受它保护。
     */
    const SCRIM_DEFAULTS = { scrim: 18, scrimBlur: 10, saturate: 100 }

    const DEFAULTS = Object.freeze({
      enabled: true,
      image: '',
      fit: 'cover',
      opacity: 100,
      surface: 0,
      blur: 0,
      dim: 0,
      ...SCRIM_DEFAULTS,
    })

    function clampInt(value, min, max, fallback) {
      const n = Math.round(Number(value))
      if (!Number.isFinite(n)) return fallback
      return Math.min(max, Math.max(min, n))
    }

    function normalize(raw) {
      const source = raw !== null && typeof raw === 'object' ? raw : {}
      return {
        enabled: typeof source.enabled === 'boolean' ? source.enabled : DEFAULTS.enabled,
        image: typeof source.image === 'string' ? source.image : DEFAULTS.image,
        fit: FIT_MODES.includes(source.fit) ? source.fit : DEFAULTS.fit,
        opacity: clampInt(source.opacity, 0, 100, DEFAULTS.opacity),
        surface: clampInt(source.surface, 0, 90, DEFAULTS.surface),
        blur: clampInt(source.blur, 0, 40, DEFAULTS.blur),
        dim: clampInt(source.dim, 0, 80, DEFAULTS.dim),
        scrim: clampInt(source.scrim, 0, 70, DEFAULTS.scrim),
        // 上限定得比图片自身的模糊高：虚化细节是"好底子"的主要手段，要给足空间。
        scrimBlur: clampInt(source.scrimBlur, 0, 40, DEFAULTS.scrimBlur),
        saturate: clampInt(source.saturate, 0, 150, DEFAULTS.saturate),
      }
    }

    function persist(settings) {
      try {
        window.localStorage.setItem(STORAGE_KEY, JSON.stringify(settings))
      } catch (error) {
        // A full quota or a storage-restricted page keeps the session working;
        // the choice simply does not survive a reload.
        console.warn('[wallpaper] 无法保存壁纸设置：', error)
      }
    }

    function load() {
      try {
        const stored = window.localStorage.getItem(STORAGE_KEY)
        return normalize(stored === null ? {} : JSON.parse(stored))
      } catch (error) {
        console.warn('[wallpaper] 读取壁纸设置失败：', error)
        return normalize({})
      }
    }

    /* ------------------------------------------------------------------ *
     * Controller: one source of truth for the page and the backdrop
     * ------------------------------------------------------------------ */

    function createController() {
      let state = load()
      const listeners = new Set()

      const emit = () => {
        for (const listener of [...listeners]) listener()
      }

      const api = {
        get: () => state,
        subscribe(listener) {
          listeners.add(listener)
          return () => listeners.delete(listener)
        },
        patch(partial) {
          state = normalize({ ...state, ...partial })
          apply(state)
          persist(state)
          emit()
        },
        replace(next) {
          state = normalize(next)
          apply(state)
          persist(state)
          emit()
        },
        reset() {
          state = normalize({ ...DEFAULTS, image: state.image })
          apply(state)
          persist(state)
          emit()
        },
        /**
         * 记录一次"粘贴闸门为什么放行/为什么不管"。
         *
         * 存在的理由：闸门太紧会变成"设置里 Ctrl+V 没反应"的静默失效，而这从外面看不出来。
         * 落盘的是**判定依据**（事件发生在谁的节点上、当时焦点在哪、面板在不在），
         * 不记录图片内容本身。离线读 localStorage 就能复盘，不需要 DevTools。
         */
        reportGate(verdict) {
          try {
            window.localStorage.setItem(GATE_KEY, JSON.stringify({ at: new Date().toISOString(), ...verdict }))
          } catch (error) {
            /* 诊断信息写不进去不能影响粘贴 */
          }
        },
      }

      apply(state)
      window.addEventListener('storage', (event) => {
        if (event.key !== STORAGE_KEY) return
        state = load()
        apply(state)
        emit()
      })
      return api
    }

    /* ------------------------------------------------------------------ *
     * Backdrop
     * ------------------------------------------------------------------ */

    function paint(settings) {
      const active = settings.enabled && settings.image !== ''
      const body = document.body
      if (body === null) return
      const root = document.documentElement

      root.setAttribute('data-dsh-wallpaper', active ? 'active' : 'inactive')

      if (!active) {
        root.style.removeProperty('--wlp-surface')
        root.style.removeProperty('--wlp-saturate')
        document.getElementById(LAYER_ID)?.remove()
        document.getElementById(SCRIM_ID)?.remove()
        return
      }

      // 变量写在根元素而不是 body：它要被所有列的规则读到，而其它插件可能在 body
      // 上写入自己的自定义属性；根元素是最不容易被就地覆盖的一层。
      root.style.setProperty('--wlp-surface', `${settings.surface}%`)
      root.style.setProperty('--wlp-saturate', String(settings.saturate / 100))

      let layer = document.getElementById(LAYER_ID)
      if (layer === null) {
        layer = document.createElement('div')
        layer.id = LAYER_ID
        layer.setAttribute('aria-hidden', 'true')
        if (!document.body.prepend(layer)) document.body.appendChild(layer)
      }
      // 薄纱层紧跟在图片层之后：它必须在图片之上、界面之下。同样用负 z-index
      // （负值之间按 DOM 顺序叠放），这样界面面板天然盖在它上面。
      let scrim = document.getElementById(SCRIM_ID)
      if (scrim === null) {
        scrim = document.createElement('div')
        scrim.id = SCRIM_ID
        scrim.setAttribute('aria-hidden', 'true')
        // 无条件插到图片层后面，让 DOM 顺序本身就表达"图片 → 薄纱"这个意图
        // （不依赖"此刻图片层后面正好还有什么"）。
        if (typeof document.body.insertBefore === 'function') document.body.insertBefore(scrim, layer.nextSibling)
        // insertBefore 缺席时退回 appendChild：层级会差一点，但"换壁纸"这件事不能因此整个失败
        // —— 装饰性插件的每一步都该是可降级的（本次就因为缺这个方法，粘贴换图直接报错）。
        else document.body.appendChild(scrim)
      }

      const repeat = settings.fit === 'tile' ? 'repeat' : 'no-repeat'
      layer.style.backgroundImage = `url("${settings.image}")`
      layer.style.backgroundRepeat = repeat
      layer.style.backgroundPosition = 'center center'
      layer.style.backgroundSize =
        settings.fit === 'cover' ? 'cover' : settings.fit === 'contain' ? 'contain' : 'auto'
      layer.style.opacity = String(settings.opacity / 100)
      layer.style.filter = settings.dim === 0 ? 'none' : `brightness(${(100 - settings.dim) / 100})`
      layer.style.setProperty('--wlp-blur', `${settings.blur}px`)

      // 薄纱的参数写在薄纱自己身上（它只被自己那条规则读，不需要跨层继承，
      // 也就不存在"被中间层就地声明遮蔽"的风险）。
      scrim.style.setProperty('--wlp-scrim', String(settings.scrim / 100))
      scrim.style.setProperty('--wlp-scrim-blur', `${settings.scrimBlur}px`)
    }

    function ensureStyles() {
      if (document.getElementById(STYLE_ID) !== null) return
      const style = document.createElement('style')
      style.id = STYLE_ID
      style.textContent = `
#${LAYER_ID} {
  position: fixed;
  inset: 0;
  z-index: -2;
  pointer-events: none;
  background-color: #0b0b0d;
  background-position: center center;
  background-repeat: no-repeat;
  background-size: cover;
  /* 饱和度单独可调：实测那种"很浓"的壁纸（饱和度 50%+）会持续拉扯注意力，
     略微降饱和比调暗更能让眼睛放松，且不会让画面发闷。 */
  filter: blur(var(--wlp-blur, 0px)) saturate(var(--wlp-saturate, 1));
  transform: scale(1.04);
  transition: opacity .2s ease-out;
}
/* 薄纱：图片之上、界面之下（同为负 z-index，按 DOM 顺序叠放）。
   两个作用 —— rgba 底色把对比度下限托起来，backdrop-filter 把高频细节抹平。 */
#${SCRIM_ID} {
  position: fixed;
  inset: 0;
  z-index: -1;
  pointer-events: none;
  background: rgba(var(--wlp-scrim-rgb, 12, 12, 14), var(--wlp-scrim, 0));
  backdrop-filter: blur(var(--wlp-scrim-blur, 0px));
  -webkit-backdrop-filter: blur(var(--wlp-scrim-blur, 0px));
  /* 轻微放大：让模糊采样不会碰到视口边缘，否则四周会出现一圈偏暗的晕边。 */
  transform: scale(1.03);
}
html[data-dsh-wallpaper="active"],
html[data-dsh-wallpaper="active"] body {
  background-color: transparent !important;
  background-image: none !important;
}
html[data-dsh-wallpaper="active"] [class*="_frame"] { background: transparent !important; }
/* 通透度只用根元素上那个内联变量，**这里绝不能给 --wlp-surface 写任何默认声明**：
   元素自己声明的值会压过继承来的值，所以只要在 body（或任何中间层）上写了默认值，
   根元素上的内联值就永远传不下来 —— 滑杆会彻底失灵，且界面看起来"不够通透"却查不出原因。
   兜底放在读取侧（RULES 里的 var(--wlp-surface, 默认值)），不放在写入侧。 */
html[data-dsh-wallpaper="active"] [class*="_sidebarCol"],
html[data-dsh-wallpaper="active"] [class*="_centerCol"],
html[data-dsh-wallpaper="active"] [class*="_rightbarCol"],
html[data-dsh-wallpaper="active"] [class*="_frame"] [class*="_root"] {
  background: color-mix(in srgb, var(--dsw-alias-bg-base) var(--wlp-surface, ${DEFAULT_SURFACE}%), transparent) !important;
}
html[data-dsh-wallpaper="active"] [class*="_sidebarCol"] {
  background: color-mix(in srgb, var(--dsw-specific-sidebar-fill, var(--dsw-alias-bg-base)) var(--wlp-surface, ${DEFAULT_SURFACE}%), transparent) !important;
}
.wlp-page {
  display: flex;
  flex-direction: column;
  gap: 18px;
  padding: 4px 2px 24px;
  color: var(--dsw-alias-label-primary);
  /* 面板会被程序化聚焦（粘贴闸门需要焦点在面板内），但不该显示焦点描边。 */
  outline: none;
}
.wlp-hint { color: var(--dsw-alias-label-secondary); font-size: 12px; line-height: 18px; }
.wlp-drop {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 8px;
  min-height: 148px;
  padding: 16px;
  border: 1px dashed var(--dsw-alias-border-l2);
  border-radius: var(--dsw-radius-md);
  background: color-mix(in srgb, var(--dsw-alias-bg-layer-2) 55%, transparent);
  cursor: pointer;
  text-align: center;
  transition: border-color .15s ease, background .15s ease;
}
.wlp-drop:hover, .wlp-drop[data-active="true"] {
  border-color: var(--dsw-alias-brand-primary);
  background: color-mix(in srgb, var(--dsw-alias-brand-primary) 8%, transparent);
}
.wlp-drop img { max-height: 96px; max-width: 100%; border-radius: var(--dsw-radius-sm); }
.wlp-drop strong { font-weight: 600; font-size: 13px; }
.wlp-row { display: flex; flex-direction: column; gap: 6px; }
.wlp-group {
  margin-top: 6px;
  padding-top: 10px;
  border-top: .5px solid var(--dsw-alias-border-l2);
  font-size: 15px;
  font-weight: 600;
  color: var(--dsw-alias-label-secondary);
}
.wlp-label {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 12px;
  font-size: 13px;
}
.wlp-value { color: var(--dsw-alias-label-secondary); font-variant-numeric: tabular-nums; font-size: 12px; }
.wlp-range { width: 100%; accent-color: var(--dsw-alias-brand-primary); }
.wlp-seg { display: flex; gap: 6px; flex-wrap: wrap; }
.wlp-seg button {
  flex: 0 0 auto;
  min-width: 64px;
  padding: 6px 12px;
  border: .5px solid var(--dsw-alias-border-l2);
  border-radius: var(--dsw-radius-sm);
  background: var(--dsw-alias-bg-layer-2);
  color: var(--dsw-alias-label-primary);
  font: inherit;
  font-size: 12px;
  cursor: pointer;
}
.wlp-seg button[data-on="true"] {
  border-color: var(--dsw-alias-brand-primary);
  background: color-mix(in srgb, var(--dsw-alias-brand-primary) 16%, transparent);
}
.wlp-actions { display: flex; gap: 8px; flex-wrap: wrap; }
.wlp-actions button {
  padding: 7px 14px;
  border: .5px solid var(--dsw-alias-border-l2);
  border-radius: var(--dsw-radius-sm);
  background: var(--dsw-alias-bg-layer-2);
  color: var(--dsw-alias-label-primary);
  font: inherit;
  font-size: 12px;
  cursor: pointer;
}
.wlp-actions button:hover { border-color: var(--dsw-alias-border-l1); }
.wlp-status { font-size: 12px; color: var(--dsw-alias-state-warn-primary); }
`
      document.head.appendChild(style)
    }

    let controller = null

    /** 元素的可读描述：优先 id，其次类名，最后标签名。 */
    const describe = (node) =>
      node === null || node === undefined
        ? 'none'
        : node.id !== ''
          ? `#${node.id}`
          : typeof node.className === 'string' && node.className !== ''
            ? `.${node.className.trim().split(/\s+/).join('.')}`
            : node.nodeName

    /**
     * 从根到该元素的路径（只看前几层，够定位是谁就行）。
     * 排查"不通透"时要能回答"这个遮挡物在界面的哪一层"。
     */
    function describePath(node) {
      const parts = []
      for (let current = node; current !== null && current !== undefined && parts.length < 6; current = current.parentElement) {
        parts.unshift(describe(current))
      }
      return parts.join(' > ')
    }

    /**
     * 采样：从背景图层的位置往下"打一条竖线"，找出所有可能挡住壁纸的元素。
     *
     * 存在的理由：壁纸看起来"不通透"时，可能是任意一层在遮挡 —— 而窗口从外面看不见。
     * 与其猜哪个参数不对，不如让插件把每一层的**背景色 / 不透明度 / 背景图**实测出来。
     * 这样"哪一层盖住了壁纸"是读出来的，不是推出来的。
     *
     * @returns 按层叠顺序排列的元素及其实测颜色，取不到则返回 null。
     */
    function sampleStack() {
      try {
        if (typeof document.elementsFromPoint !== 'function' || typeof window.innerHeight !== 'number') return null
        // 采样点取界面中部：壁纸层铺满视口，但这个点必须能命中"界面元素"本身，
        // 所以不去命中壁纸层（它是 pointer-events:none，本来就命中不到）。
        const point = { x: Math.round(window.innerWidth / 2), y: Math.round(window.innerHeight / 3) }
        const nodes = document.elementsFromPoint(point.x, point.y)
        const stack = []
        for (const node of nodes.slice(0, 8)) {
          const view = getComputedStyle(node)
          // backgroundColor 的 alpha 是"这一层挡了多少"的关键；rgba(...) 与 rgb(...) 两种形态都要认。
          const parsed = /rgba?\(([^)]+)\)/.exec(view.backgroundColor)
          const parts = parsed === null ? [] : parsed[1].split(',').map((piece) => piece.trim())
          const alpha = parts.length === 4 ? Number.parseFloat(parts[3]) : parts.length === 3 ? 1 : null
          stack.push({
            el: describe(node),
            bg: view.backgroundColor,
            alpha,
            opacity: view.opacity,
            bgImage: view.backgroundImage === 'none' ? '' : view.backgroundImage.slice(0, 50),
            z: view.zIndex,
            text: (node.textContent ?? '').trim().replace(/\s+/g, ' ').slice(0, 20),
          })
        }
        return {
          point,
          // 从最上层往下（elementsFromPoint 的顺序）：第一个"实色且无背景图"的就是把壁纸盖死的元凶。
          topDown: stack,
          opaqueBlockers: stack.filter((entry) => entry.alpha === 1 && entry.bgImage === '').map((entry) => entry.el),
          tintedBlockers: stack.filter((entry) => entry.alpha !== null && entry.alpha > 0 && entry.alpha < 1).map((entry) => `${entry.el} @${entry.alpha}`),
        }
      } catch (error) {
        return null
      }
    }

    /**
     * 记录一次"应用后的 DOM 实测值"，供离线排查使用。
     *
     * 存在的理由：壁纸的表现（透明度、模糊、界面通透度）是 CSS 级联与计算样式的结果，
     * 而这个窗口从外面看不到。历史上出现过"设置了但屏幕上没变化"的问题，只靠读源码
     * 无法区分是"没写进去"还是"写进去了但被覆盖"。这份指纹把两者分开：
     *   - `layerOpacity` / `layerFilter`：写进内联样式了吗；
     *   - `layerComputedOpacity`：浏览器实际算出来是多少（被覆盖就会与上一项不符）；
     *   - `columnComputedBackground`：界面通透度那条规则最终算出来的背景色；
     *   - `surfaceVariableOnColumn`：变量到底有没有继承到那一层（没继承就会用回退值）；
     *   - `scrim`：薄纱层是否在、它实测出来的底色与模糊（治"眼睛累"的那一层）；
     *   - `stack`：壁纸层往上实际叠了哪些元素、各自什么颜色（回答"谁在挡着壁纸"）。
     * 全部取自 getComputedStyle，是**观测值而不是意图值**。
     * @param settings - 本次应用的偏好。
     */
    function recordFingerprint(settings) {
      try {
        const layer = document.getElementById(LAYER_ID)
        const scrim = document.getElementById(SCRIM_ID)
        const column = document.querySelector('[class*="_centerCol"]')
        const fingerprint = {
          at: new Date().toISOString(),
          settings: {
            enabled: settings.enabled,
            hasImage: settings.image !== '',
            surface: settings.surface,
            opacity: settings.opacity,
            blur: settings.blur,
            dim: settings.dim,
            scrim: settings.scrim,
            scrimBlur: settings.scrimBlur,
            saturate: settings.saturate,
          },
          layerPresent: layer !== null,
          layerInlineOpacity: layer?.style.opacity ?? null,
          layerInlineFilter: layer?.style.filter ?? null,
          layerComputedOpacity: layer === null ? null : getComputedStyle(layer).opacity,
          layerComputedFilter: layer === null ? null : getComputedStyle(layer).filter,
          layerZIndex: layer === null ? null : getComputedStyle(layer).zIndex,
          surfaceVariableOnRoot: getComputedStyle(document.documentElement).getPropertyValue('--wlp-surface').trim(),
          surfaceVariableOnColumn: column === null ? null : getComputedStyle(column).getPropertyValue('--wlp-surface').trim(),
          scrimPresent: scrim !== null,
          scrimComputedBackground: scrim === null ? null : getComputedStyle(scrim).backgroundColor,
          scrimComputedZIndex: scrim === null ? null : getComputedStyle(scrim).zIndex,
          scrimComputedBackdrop: scrim === null ? null : getComputedStyle(scrim).backdropFilter,
          columnPresent: column !== null,
          columnPath: column === null ? null : describePath(column),
          columnComputedBackground: column === null ? null : getComputedStyle(column).backgroundColor,
          stack: sampleStack(),
        }
        window.localStorage.setItem(FINGERPRINT_KEY, JSON.stringify(fingerprint))
      } catch (error) {
        /* 自检失败不能影响壁纸本身 */
        console.warn('[wallpaper] 自检记录失败：', error)
      }
    }

    function apply(settings) {
      if (typeof document === 'undefined') return
      ensureStyles()
      paint(settings)
      recordFingerprint(settings)
    }

    /* ------------------------------------------------------------------ *
     * Paste intake
     * ------------------------------------------------------------------ */

    /**
     * 当前挂载的壁纸设置面板宿主节点（`.wlp-page`），未挂载时为 null。
     *
     * 它同时承担两件事：判断"这个粘贴是不是发生在壁纸面板里"，以及判断"面板是不是
     * 真的显示着"（不在文档里的节点、或被隐藏的节点，取不到非空矩形）。
     */
    let wallpaperPanel = null

    /** 面板确实显示在页面上（而不是仅仅被挂载）。 */
    function panelIsOpen() {
      if (wallpaperPanel === null || typeof wallpaperPanel.getBoundingClientRect !== 'function') return false
      try {
        const rect = wallpaperPanel.getBoundingClientRect()
        return rect.width > 0 || rect.height > 0
      } catch (error) {
        return false
      }
    }

    const nodeName = (node) => (node === null || node === undefined ? 'none' : node.id || node.className || node.nodeName || 'unknown')

    /**
     * 粘贴闸门的唯一判据：**按 Ctrl+V 那一刻，焦点是不是在壁纸设置面板里**。
     *
     * 历史事故（必须靠这段代码拦住）：早先版本直接在 `window` 上装全局 `paste` 监听，
     * 只要剪贴板里有图就 `preventDefault` 并写进壁纸设置 —— 于是用户在对话框里粘一张图
     * 发给会话时，壁纸被换掉了，而那张图也没进输入框。**没有用户的明确意图，界面插件
     * 不该改写任何设置**，所以这里的默认答案是"不管"。
     *
     * 为什么只认焦点、不认"面板挂在屏幕上"：实测过 —— 面板节点即使设置窗已经关掉，
     * 仍然可能留在文档里并报出非空矩形，用它当判据会把"用户在对话框粘图"误判成
     * "用户在改壁纸"。而"焦点在面板内"在用户回到对话框时就一定不成立，是可靠的信号。
     * 为了让这条判据在正常使用下不苛刻，面板挂载时会主动把焦点收到自己身上（见
     * `WallpaperPage`），于是"打开壁纸页 → Ctrl+V"直接可用。
     *
     * @returns {{ok: boolean, reason: string}} 放行结论与依据。
     */
    function pasteIntent(event) {
      if (wallpaperPanel === null) return { ok: false, reason: 'no-panel' }
      const target = event?.target ?? null
      const active = typeof document === 'undefined' ? null : document.activeElement
      const focusedInside = active !== null && active !== undefined && wallpaperPanel.contains?.(active) === true
      if (focusedInside) return { ok: true, reason: 'panel-focused' }
      const insideTarget = target !== null && wallpaperPanel.contains?.(target) === true
      if (insideTarget) return { ok: true, reason: 'panel-target' }
      return {
        ok: false,
        reason: panelIsOpen() ? 'panel-open-focus-elsewhere' : 'panel-hidden',
        target: nodeName(target),
        active: nodeName(active),
      }
    }

    /** 从剪贴板数据里取出第一张图片文件；没有就返回 null（纯文本粘贴不属于壁纸）。 */
    function firstImageFile(clipboard) {
      const items = clipboard?.items
      if (items === undefined || items === null) return null
      for (const item of items) {
        if (item?.kind !== 'file') continue
        if (typeof item.type !== 'string' || !item.type.startsWith('image/')) continue
        const file = item.getAsFile?.()
        if (file !== null && file !== undefined) return file
      }
      return null
    }

    /**
     * 装一个粘贴入口：只有在壁纸面板上发生的粘贴才会换壁纸。
     *
     * 监听器挂在 `window` 的**捕获**阶段：面板里的 input 自己没有粘贴处理，事件会
     * 冒泡到 window，两者都能收到；挂在捕获阶段是为了在应用自己的处理器之前就决定
     * 去留。判定为"与壁纸无关"时**什么都不做**（不 preventDefault、不 stopPropagation），
     * 应用该怎么粘贴就怎么粘贴。
     */
    function watchPaste() {
      const onPaste = (event) => {
        // 先做最便宜的判断：面板没挂载就整段跳过（应用里的每次粘贴都会经过这里，
        // 不该为"壁纸面板根本没打开"的常见情形建对象）。
        const intent = wallpaperPanel === null ? { ok: false, reason: 'no-panel' } : pasteIntent(event)
        let handled = false
        if (intent.ok) {
          const file = firstImageFile(event.clipboardData)
          if (file !== null) {
            event.preventDefault()
            handled = true
            void acceptFile(file, (dataUrl) => {
              controller.patch({ image: dataUrl, enabled: true })
            }).catch((error) => console.warn('[wallpaper] 粘贴图片失败：', error))
          }
        }
        if (controller !== null) controller.reportGate({ ...intent, handled, imageTaken: handled })
      }
      window.addEventListener('paste', onPaste, true)
      return () => window.removeEventListener('paste', onPaste, true)
    }

    /* ------------------------------------------------------------------ *
     * Image intake
     * ------------------------------------------------------------------ */

    function readAsDataUrl(file) {
      return new Promise((resolve, reject) => {
        const reader = new FileReader()
        reader.onload = () => resolve(String(reader.result))
        reader.onerror = () => reject(reader.error ?? new Error('读取文件失败'))
        reader.readAsDataURL(file)
      })
    }

    function loadImage(dataUrl) {
      return new Promise((resolve, reject) => {
        const image = new Image()
        image.onload = () => resolve(image)
        image.onerror = () => reject(new Error('这不是一张能解码的图片'))
        image.src = dataUrl
      })
    }

    function encode(image, scale, type, quality) {
      const width = Math.max(1, Math.round(image.naturalWidth * scale))
      const height = Math.max(1, Math.round(image.naturalHeight * scale))
      const canvas = document.createElement('canvas')
      canvas.width = width
      canvas.height = height
      const context = canvas.getContext('2d')
      if (context === null) throw new Error('无法创建画布')
      context.drawImage(image, 0, 0, width, height)
      return canvas.toDataURL(type, quality)
    }

    /**
     * Turn one user-chosen file into a stored data URL, staying inside the
     * storage quota by stepping the long edge down until the write fits.
     * @param file - the chosen image file.
     * @param commit - receives the stored data URL.
     */
    async function acceptFile(file, commit) {
      if (file === undefined || file === null) return
      if (typeof file.type === 'string' && file.type !== '' && !file.type.startsWith('image/')) {
        throw new Error('请选择图片文件（PNG / JPEG / WebP / GIF）')
      }
      const original = await readAsDataUrl(file)
      let image
      try {
        image = await loadImage(original)
      } catch (error) {
        throw new Error(`无法显示这张图片：${error.message}`)
      }

      const longest = Math.max(image.naturalWidth, image.naturalHeight)
      const firstScale = longest > MAX_EDGE ? MAX_EDGE / longest : 1
      const opaque = file.type !== 'image/png'
      const ladder = []
      for (const scale of [firstScale, firstScale * 0.75, firstScale * 0.5, firstScale * 0.35]) {
        if (scale <= 0) continue
        ladder.push([scale, opaque && scale < 1 ? 'image/jpeg' : file.type || 'image/png', opaque ? 0.85 : undefined])
        if (scale < 1) ladder.push([scale, 'image/jpeg', 0.82])
      }

      let last = original
      for (const [scale, type, quality] of ladder) {
        let encoded
        try {
          encoded = encode(image, scale, type, quality)
        } catch {
          continue
        }
        last = encoded
        if (encoded !== original && encoded.length > 4_500_000) continue
        commit(encoded)
        return
      }
      commit(last)
    }

    /* ------------------------------------------------------------------ *
     * Settings page
     * ------------------------------------------------------------------ */

    function Slider({ label, valueText, min, max, step, value, onChange }) {
      return h(
        'div',
        { className: 'wlp-row' },
        h(
          'div',
          { className: 'wlp-label' },
          h('span', null, label),
          h('span', { className: 'wlp-value' }, valueText),
        ),
        h('input', {
          className: 'wlp-range',
          type: 'range',
          min,
          max,
          step,
          value,
          'aria-label': label,
          onChange: (event) => onChange(Number(event.currentTarget.value)),
        }),
      )
    }

    function Choice({ label, options, value, onChange }) {
      return h(
        'div',
        { className: 'wlp-row' },
        h('div', { className: 'wlp-label' }, h('span', null, label)),
        h(
          'div',
          { className: 'wlp-seg', role: 'group', 'aria-label': label },
          options.map((option) =>
            h(
              'button',
              {
                key: option.value,
                type: 'button',
                'data-on': option.value === value ? 'true' : 'false',
                onClick: () => onChange(option.value),
              },
              option.label,
            ),
          ),
        ),
      )
    }

    function WallpaperPage({ t }) {
      const settings = useSyncExternalStore(controller.subscribe, controller.get, controller.get)
      const inputRef = useRef(null)
      const [error, setError] = useState('')
      const [busy, setBusy] = useState(false)
      const [dropping, setDropping] = useState(false)

      /**
       * 面板宿主节点要交给插件：粘贴闸门靠它判断"这次粘贴是不是发生在面板里"。
       * 用内联回调而不是 ref 对象，是为了卸载时能确保把引用清掉（ref 对象在组件
       * 卸载后仍会被 React 置空，但内联回调的语义更直白，也不依赖 React 版本细节）。
       */
      const bindPanel = (node) => {
        wallpaperPanel = node
      }

      const choose = async (file) => {
        if (file === undefined || file === null) return
        setBusy(true)
        setError('')
        try {
          await acceptFile(file, (dataUrl) => controller.patch({ image: dataUrl, enabled: true }))
        } catch (failure) {
          setError(failure instanceof Error ? failure.message : String(failure))
        } finally {
          setBusy(false)
        }
      }

      /**
       * 面板一挂载就把焦点收进来：粘贴闸门认的是"焦点在面板内"，而宿主不保证
       * 打开设置页时会移动焦点。放在面板容器上（不是输入框控件）不会打断输入，
       * 按 Tab 照常走向下一个控件。取不到焦点也不影响任何功能。
       */
      useEffect(() => {
        try {
          wallpaperPanel?.focus?.()
        } catch (error) {
          /* 焦点是锦上添花，失败就退回到"点一下面板" */
        }
      }, [])

      const fitLabels = {
        cover: t('fit.cover'),
        contain: t('fit.contain'),
        tile: t('fit.tile'),
        center: t('fit.center'),
      }

      return h(
        'div',
        {
          className: 'wlp-page',
          ref: bindPanel,
          // 程序化聚焦需要一个可聚焦的宿主；-1 表示"可由脚本聚焦，但不进 Tab 顺序"。
          tabIndex: -1,
          onDragOver: (event) => {
            event.preventDefault()
            setDropping(true)
          },
          onDragLeave: () => setDropping(false),
          onDrop: (event) => {
            event.preventDefault()
            setDropping(false)
            void choose(event.dataTransfer?.files?.[0])
          },
        },
        h(
          'div',
          {
            className: 'wlp-drop',
            'data-active': dropping ? 'true' : 'false',
            role: 'button',
            tabIndex: 0,
            onClick: () => inputRef.current?.click(),
            onKeyDown: (event) => {
              if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault()
                inputRef.current?.click()
              }
            },
          },
          settings.image === ''
            ? h('strong', null, t('pick'))
            : h('img', { src: settings.image, alt: '' }),
          h('span', { className: 'wlp-hint' }, busy ? t('reading') : t('pickHint')),
        ),
        h('input', {
          ref: inputRef,
          type: 'file',
          accept: 'image/*',
          style: { display: 'none' },
          onChange: (event) => {
            const file = event.currentTarget.files?.[0]
            event.currentTarget.value = ''
            void choose(file)
          },
        }),
        error === '' ? null : h('div', { className: 'wlp-status' }, error),
        h(Choice, {
          label: t('fit'),
          value: settings.fit,
          onChange: (fit) => controller.patch({ fit }),
          options: FIT_MODES.map((mode) => ({ value: mode, label: fitLabels[mode] })),
        }),
        settings.fit === 'tile' || settings.fit === 'center'
          ? h('p', { className: 'wlp-hint', style: { fontSize: '16px', lineHeight: '22px' } }, t('fitHint'))
          : null,
        h(Slider, {
          label: t('opacity'),
          valueText: `${settings.opacity}%`,
          min: 10,
          max: 100,
          step: 1,
          value: settings.opacity,
          onChange: (opacity) => controller.patch({ opacity }),
        }),
        h(Slider, {
          label: t('surface'),
          valueText: `${settings.surface}%`,
          min: 0,
          max: 90,
          step: 1,
          value: settings.surface,
          onChange: (surface) => controller.patch({ surface }),
        }),
        h(Slider, {
          label: t('dim'),
          valueText: `${settings.dim}%`,
          min: 0,
          max: 80,
          step: 1,
          value: settings.dim,
          onChange: (dim) => controller.patch({ dim }),
        }),
        h('div', { className: 'wlp-group' }, t('groupComfort')),
        h(Slider, {
          label: t('scrim'),
          valueText: `${settings.scrim}%`,
          min: 0,
          max: 70,
          step: 1,
          value: settings.scrim,
          onChange: (scrim) => controller.patch({ scrim }),
        }),
        h(Slider, {
          label: t('scrimBlur'),
          valueText: `${settings.scrimBlur}px`,
          min: 0,
          max: 40,
          step: 1,
          value: settings.scrimBlur,
          onChange: (scrimBlur) => controller.patch({ scrimBlur }),
        }),
        h(
          'div',
          { className: 'wlp-actions' },
          h(
            'button',
            {
              type: 'button',
              disabled: settings.image === '',
              onClick: () => controller.patch({ image: '', enabled: false }),
            },
            t('remove'),
          ),
        ),
        h('p', { className: 'wlp-hint', style: { textAlign: 'center' } }, 'v' + VERSION),
      )
    }

    /* ------------------------------------------------------------------ *
     * Plugin body
     * ------------------------------------------------------------------ */

    const NS = 'ui-wallpaper'
    const DICT = {
      zh: {
        'section.nav': '壁纸',
        pick: '点击选择本机图片',
        pickHint: '可以把图片拖到这里，或者在这里按 Ctrl+V 换壁纸',
        reading: '正在处理图片…',
        fit: '铺满方式',
        'fit.cover': '铺满',
        'fit.contain': '完整显示',
        'fit.tile': '平铺',
        'fit.center': '居中',
        fitHint: '平铺与居中适合小于屏幕的图片；大图的效果与铺满相同',
        opacity: '壁纸不透明度',
        surface: '界面通透度',
        dim: '压暗',
        groupComfort: '蒙版',
        scrim: '压底薄纱',
        scrimBlur: '薄纱虚化',
        remove: '移除壁纸',
      },
      en: {
        'section.nav': 'Wallpaper',
        pick: 'Click to choose a local image',
        pickHint: 'or drop an image here; Ctrl+V changes the wallpaper only inside this panel',
        reading: 'Processing image…',
        fit: 'Fit',
        'fit.cover': 'Cover',
        'fit.contain': 'Contain',
        'fit.tile': 'Tile',
        'fit.center': 'Center',
        fitHint: 'Tile and Center suit images smaller than the screen; large images look the same as Cover',
        opacity: 'Wallpaper opacity',
        surface: 'Surface transparency',
        dim: 'Dim',
        groupComfort: 'Mask',
        scrim: 'Scrim',
        scrimBlur: 'Scrim blur',
        remove: 'Remove',
      },
    }

    /**
     * Register one locale namespace and return its translator, falling back to
     * the source dictionary while the locale service is unavailable.
     * @param ctx - the client plugin context.
     * @returns the namespace-bound translator.
     */
    function bindLocale(ctx) {
      try {
        ctx.locale.register(NS, 'zh', DICT.zh)
        ctx.locale.register(NS, 'en', DICT.en)
        return ctx.locale.bind(NS)
      } catch (error) {
        console.warn('[wallpaper] 本地化服务不可用，使用内置文案：', error)
        return (key) => DICT.zh[key] ?? key
      }
    }

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        ensureStyles()
        controller = createController()

        const t = bindLocale(ctx)

        ctx.effect(() => () => {
          document.getElementById(LAYER_ID)?.remove()
          document.getElementById(SCRIM_ID)?.remove()
          document.getElementById(STYLE_ID)?.remove()
          document.documentElement.removeAttribute('data-dsh-wallpaper')
          // 变量写在根元素上，清理也必须落在同一处，否则卸载后会留下残留值。
          document.documentElement.style.removeProperty('--wlp-surface')
          document.documentElement.style.removeProperty('--wlp-saturate')
          document.body?.style.removeProperty('--wlp-surface')
          wallpaperPanel = null
        })

        ctx.effect(watchPaste)

        ctx.slots.inject('settings.section', () =>
          ctx.slots.register(
            {
              name: 'settings.section',
              id: 'wallpaper',
              order: 60,
              label: () => t('section.nav'),
              locale: NS,
            },
            () => h(WallpaperPage, { t }),
          ),
        )
      },
    }
  },
})

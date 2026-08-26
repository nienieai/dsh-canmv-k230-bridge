// ============================================================
// CanMV K230 桥接插件 —— Client 半侧（v12.23：设置页开关悬浮窗）
// shell.overlay 里的可拖拽、可收起悬浮面板：
//   [连接|断开]/信息/复位 | 📂打开脚本/拖放载入 | [运行|停止]/预览 | 面板状态 / 开发板调试
// 通过 Package 私有 RPC 调用 Host 半侧（panel.* 方法）。
// v12.15：连接/断开合并为双态按键；运行/停止合并为双态按键；2 秒端口枚举跟随。
// v12.16：状态行「发现 CanMV 开发板 / 未发现 CanMV 开发板」。
// v12.17：脚本载入改为「📂 打开脚本」系统文件选择框 + 拖放 .py 到面板载入。
// v12.18：运行成功后自动开启预览（等待 started 后发 preview.on）。
// v12.19：修复 v12.18 的时序缺陷——旧 status.json 残留 started:true 会让面板在
//   板子真正启动前就发 preview-on，被会话 PS 启动阶段的 cmd.json 清理吞掉，导致
//   预览永远「等待首帧」。现在必须等【本次运行之后】写出的新状态文件
//   （status.at > runStartedAtLive 且 started=true）才发指令；手动点预览在未就绪时
//   改为挂起（再次点击可取消）；45 秒未启动自动放弃；preview-on 发出 15 秒后
//   fb 仍为 false 时自动重发一次（看门狗，一次性）。
// v12.21：面板状态消息（连接/断开/运行/停止/预览/载入/错误等）不再写入底部大框——
//   底部框是开发板调试框，只显示板子的 print/REPL/复位启动输出；面板状态改写入
//   其上方独立的「面板状态」小框（最新在上，最多 14 行）。板子输出流里的会话 PS
//   诊断行（SESSION/SCRIPT VERIFY/…）也归入面板状态，不进调试框。
// v12.22：帧冻结可见性——status.frameStall=true（板子显示管线失效、画面停止更新但
//   连接正常）时，面板状态行追加「⚠ 帧冻结」，并在「面板状态」小框提示一次（恢复后
//   可再次提示）。
// v12.23：新增设置页「CanMV」——可开关悬浮窗。模块级可见性 + 订阅广播：
//   设置页与悬浮窗共享同一状态，任一侧切换双方立即同步；关闭后悬浮窗
//   与收起药丸都不渲染（下次开启自动恢复）。
// ============================================================
return {
  inject: ['timer'],
  apply(ctx) {
    const slots = ctx.get('slots')
    if (slots === undefined) return

    styles.insert([
      '.cmv-panel {',
      '  position: fixed; width: 360px; max-height: 78vh; display: flex; flex-direction: column;',
      '  background: var(--dsw-alias-bg-overlay); border: 1px solid var(--dsw-alias-border-l2);',
      '  border-radius: 12px; box-shadow: 0 12px 32px rgba(0,0,0,.28);',
      '  color: var(--dsw-alias-label-primary); font: 12px/1.5 system-ui, sans-serif;',
      '  z-index: 40; overflow: hidden; pointer-events: auto;',
      '}',
      '.cmv-panel.cmv-drop { outline: 2px dashed var(--dsw-alias-brand-primary); outline-offset: -2px; }',
      '.cmv-pill {',
      '  position: fixed; display: flex; align-items: center; gap: 6px; padding: 6px 12px;',
      '  border-radius: 999px; background: var(--dsw-alias-bg-overlay);',
      '  border: 1px solid var(--dsw-alias-border-l2); box-shadow: 0 4px 12px rgba(0,0,0,.25);',
      '  cursor: pointer; pointer-events: auto; color: var(--dsw-alias-label-primary);',
      '  font-size: 12px; z-index: 40; user-select: none;',
      '}',
      '.cmv-header {',
      '  display: flex; align-items: center; gap: 8px; padding: 8px 10px;',
      '  background: var(--dsw-alias-bg-layer-1); border-bottom: 1px solid var(--dsw-alias-border-l1);',
      '  cursor: move; user-select: none; touch-action: none;',
      '}',
      '.cmv-title { font-weight: 600; }',
      '.cmv-port { color: var(--dsw-alias-label-secondary); margin-left: auto; font-family: ui-monospace, Consolas, monospace; }',
      '.cmv-x { background: transparent; border: 1px solid var(--dsw-alias-border-l1); border-radius: 6px;',
      '  color: var(--dsw-alias-label-secondary); cursor: pointer; width: 22px; height: 22px; font-size: 11px; }',
      '.cmv-dot { width: 9px; height: 9px; border-radius: 50%; background: #9ca3af; flex: none; }',
      '.cmv-dot.cmv-run { background: #8b5cf6; }',
      '.cmv-ok { background: var(--dsw-alias-state-success-primary); }',
      '.cmv-err { background: var(--dsw-alias-state-error-primary); }',
      '.cmv-busy { background: var(--dsw-alias-state-warn-primary); }',
      '.cmv-body { display: flex; flex-direction: column; gap: 8px; padding: 10px; }',
      '.cmv-status { color: var(--dsw-alias-label-secondary); min-height: 16px; }',
      '.cmv-btns { display: flex; gap: 6px; flex-wrap: wrap; align-items: center; }',
      '.cmv-btns button { background: var(--dsw-alias-bg-layer-2);',
      '  border: 1px solid var(--dsw-alias-border-l2); color: var(--dsw-alias-label-primary);',
      '  border-radius: 8px; padding: 5px 10px; cursor: pointer; font-size: 12px; }',
      '.cmv-btns button:hover:not(:disabled) { border-color: var(--dsw-alias-brand-primary); }',
      '.cmv-btns button:disabled { opacity: .5; cursor: default; }',
      '.cmv-btns button.on { border-color: var(--dsw-alias-state-success-primary); color: var(--dsw-alias-state-success-primary); }',
      '.cmv-btns button.danger { color: var(--dsw-alias-state-error-primary); }',
      '.cmv-file { background: var(--dsw-alias-bg-layer-2);',
      '  border: 1px solid var(--dsw-alias-border-l2); color: var(--dsw-alias-label-primary);',
      '  border-radius: 8px; padding: 5px 10px; cursor: pointer; font-size: 12px; user-select: none; }',
      '.cmv-file:hover { border-color: var(--dsw-alias-brand-primary); }',
      '.cmv-file input { display: none; }',
      '.cmv-loaded { color: var(--dsw-alias-label-secondary); min-width: 0; overflow: hidden;',
      '  text-overflow: ellipsis; white-space: nowrap; }',
      '.cmv-hint { color: var(--dsw-alias-label-secondary); font-size: 11px; }',
      // v12.21：面板状态小框（最新在上）与开发板调试大框分开
      '.cmv-boxhead { color: var(--dsw-alias-label-secondary); font-size: 11px; margin-top: 2px; }',
      '.cmv-status-log { margin: 0; max-height: 72px; overflow: auto; background: var(--dsw-alias-bg-layer-2);',
      '  border: 1px solid var(--dsw-alias-border-l1); border-radius: 8px; padding: 6px 8px;',
      '  font-family: ui-monospace, Consolas, monospace; font-size: 11px;',
      '  white-space: pre-wrap; word-break: break-all; }',
      '.cmv-log { margin: 0; max-height: 180px; overflow: auto; background: var(--dsw-alias-bg-layer-2);',
      '  border: 1px solid var(--dsw-alias-border-l1); border-radius: 8px; padding: 8px;',
      '  font-family: ui-monospace, Consolas, monospace; font-size: 11px;',
      '  white-space: pre-wrap; word-break: break-all; }',
      '.cmv-preview-box { position: relative; width: 100%; border: 1px solid var(--dsw-alias-border-l1);',
      '  border-radius: 8px; overflow: hidden; background: #000; min-height: 120px;',
      '  display: flex; align-items: center; justify-content: center; }',
      '.cmv-preview-box img { width: 100%; display: block; image-rendering: auto; }',
      '.cmv-preview-hint { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center;',
      '  color: rgba(255,255,255,.6); font-size: 11px; }',
    ].join('\n'))

    // ---------------- v12.7：UTF-8 传输加固 ----------------
    // Client↔Host RPC 曾出现 UTF-8 文本被按 Latin-1 解码的乱码
    // （实测交付脚本 = latin1Decode(utf8Encode(原文))）。载荷统一走
    // ASCII-safe base64（纯 ASCII 对 Latin-1 变换免疫）；旧字段回退时
    // 做逆变换修复。
    function b64EncodeUtf8(s) {
      try { return btoa(unescape(encodeURIComponent(s))) } catch (e) { return null }
    }
    function b64DecodeUtf8(b) {
      try { return decodeURIComponent(escape(atob(b))) } catch (e) { return null }
    }
    function repairMojibake(text) {
      if (typeof text !== 'string' || text.length === 0) return text
      let hasWide = false
      for (let i = 0; i < text.length; i++) {
        if (text.charCodeAt(i) > 0xFF) { hasWide = true; break }
      }
      if (hasWide) return text
      const bytes = []
      for (let i = 0; i < text.length; i++) bytes.push(text.charCodeAt(i) & 0xFF)
      let out = ''
      let i = 0
      try {
        while (i < bytes.length) {
          const b0 = bytes[i]
          if (b0 < 0x80) { out += String.fromCharCode(b0); i += 1; continue }
          if (b0 >= 0xC2 && b0 <= 0xDF) {
            const b1 = bytes[i + 1]
            if ((b1 & 0xC0) !== 0x80) throw new Error('bad utf8')
            out += String.fromCharCode(((b0 & 0x1F) << 6) | (b1 & 0x3F)); i += 2; continue
          }
          if (b0 >= 0xE0 && b0 <= 0xEF) {
            const b1 = bytes[i + 1], b2 = bytes[i + 2]
            if ((b1 & 0xC0) !== 0x80 || (b2 & 0xC0) !== 0x80) throw new Error('bad utf8')
            out += String.fromCharCode(((b0 & 0x0F) << 12) | ((b1 & 0x3F) << 6) | (b2 & 0x3F)); i += 3; continue
          }
          if (b0 >= 0xF0 && b0 <= 0xF4) {
            const b1 = bytes[i + 1], b2 = bytes[i + 2], b3 = bytes[i + 3]
            if ((b1 & 0xC0) !== 0x80 || (b2 & 0xC0) !== 0x80 || (b3 & 0xC0) !== 0x80) throw new Error('bad utf8')
            const cp = ((b0 & 0x07) << 18) | ((b1 & 0x3F) << 12) | ((b2 & 0x3F) << 6) | (b3 & 0x3F)
            out += String.fromCharCode(0xD800 + ((cp - 0x10000) >> 10), 0xDC00 + ((cp - 0x10000) & 0x3FF)); i += 4; continue
          }
          throw new Error('bad utf8')
        }
      } catch (e) {
        return text
      }
      return out
    }
    function codeFromLoad(r) {
      if (r && typeof r.codeB64 === 'string' && r.codeB64.length > 0) {
        const d = b64DecodeUtf8(r.codeB64)
        if (d !== null) return d
      }
      if (r && typeof r.code === 'string') return repairMojibake(r.code)
      return ''
    }

    let previewEnabledLive = false
    let sessionActiveLive = false
    // v12.12：断开后抑制 poll 的"脚本已结束"覆盖，保持"未连接"状态
    let disconnectedLive = false
    // v12.15：模块级镜像（供定时枚举 tick 读取，避免闭包旧值）
    let connectedLive = false
    let busyLive = false
    // v12.18：运行成功后自动开预览的挂起标记（等板子 started 再发 preview.on）
    let autoPreviewLive = false
    // v12.19：时序修复用的模块级状态
    let runStartedAtLive = 0      // 本次「运行」点击的时刻（用于识别新鲜 status）
    let previewArmedAtLive = 0    // preview.on 真正发出的时刻（看门狗用）
    let previewWarnedLive = false // 看门狗只重发一次
    // v12.22：帧冻结提示只发一次（恢复后重置）
    let stallWarnedLive = false

    // ---------------- v12.23：悬浮窗开关（设置页「CanMV」控制） ----------------
    // 模块级可见性 + 轻量订阅广播：设置页与悬浮窗共享同一状态，任一侧
    // 切换双方立即同步（React state 无法跨组件共享，用 listeners 广播）。
    let panelVisibleLive = true
    const visibleListeners = new Set()
    function setPanelVisible(v) {
      panelVisibleLive = !!v
      visibleListeners.forEach((fn) => { try { fn(panelVisibleLive) } catch (e) {} })
    }
    function usePanelVisible() {
      const [v, setV] = React.useState(panelVisibleLive)
      React.useEffect(() => {
        visibleListeners.add(setV)
        return () => { visibleListeners.delete(setV) }
      }, [])
      return [v, setPanelVisible]
    }

    function Panel() {
      const [open, setOpen] = React.useState(true)
      const [busy, setBusy] = React.useState(false)
      const [status, setStatus] = React.useState({ state: 'idle', text: '未连接' })
      const [connected, setConnected] = React.useState(false)
      const [portInfo, setPortInfo] = React.useState(null)
      const [hasBoard, setHasBoard] = React.useState(false)
      const [enumErr, setEnumErr] = React.useState('')
      // v12.21：底部大框 = 开发板调试框（只放板子输出）；面板状态走独立小框
      const [debugLog, setDebugLog] = React.useState('')
      const [statusLog, setStatusLog] = React.useState('')
      const [runCode, setRunCode] = React.useState('')
      const [loadedFile, setLoadedFile] = React.useState('')
      const [dragOver, setDragOver] = React.useState(false)
      const [pos, setPos] = React.useState({ x: 16, y: 96 })
      const [drag, setDrag] = React.useState(null)
      const [session, setSession] = React.useState(null)
      const [previewOn, setPreviewOn] = React.useState(false)
      const [frame, setFrame] = React.useState(null)
      const [starting, setStarting] = React.useState(false)
      // v12.23：悬浮窗开关（设置页联动）——关闭时整个面板（含收起药丸）不渲染
      const [visible] = usePanelVisible()

      // v12.21：面板状态——最新在上，最多 14 行（不进底部调试框）
      function statusLine(text) {
        const t = String(text)
        setStatusLog(prev => {
          const lines = prev ? prev.split('\n') : []
          return [t].concat(lines).slice(0, 14).join('\n')
        })
      }

      // v12.21：开发板调试输出——只追加板子的 print/REPL/启动信息
      function appendDebug(text) {
        const t = String(text)
        if (t.length === 0) return
        setDebugLog(prev => {
          const merged = prev ? prev + '\n' + t : t
          return merged.split('\n').slice(-400).join('\n')
        })
      }

      // v12.21：板子输出流里剔除会话 PS 自写的诊断行（SESSION/SCRIPT VERIFY/
      // SCRIPT DELIVERY REFUSED），它们属于面板状态，不进开发板调试框。
      function routeOutput(text) {
        const raw = String(text || '')
        if (raw.length === 0) return
        const parts = raw.split(/\r?\n/)
        const dbg = []
        const diag = []
        for (let i = 0; i < parts.length; i++) {
          const line = parts[i]
          if (line.length > 0 && /^(SESSION\b|SCRIPT VERIFY|SCRIPT DELIVERY)/.test(line)) diag.push(line)
          else dbg.push(line)
        }
        let hasDbg = false
        for (let i = 0; i < dbg.length; i++) { if (dbg[i].length > 0) { hasDbg = true; break } }
        if (hasDbg) appendDebug(dbg.join('\n').replace(/\n+$/, ''))
        for (let i = 0; i < diag.length; i++) statusLine('[会话] ' + diag[i])
      }

      async function call(method, args) {
        try { return await host.call(method, args || {}) }
        catch (e) { return { ok: false, error: String((e && e.message) || e) } }
      }

      function markConnected(port) {
        connectedLive = true
        setConnected(true)
        if (port) setPortInfo({ port: port })
      }

      async function connect() {
        if (busy) return
        disconnectedLive = false
        busyLive = true
        setBusy(true)
        setStatus({ state: 'busy', text: '检测串口中…' })
        const rep = { ok: false, port: '', status: '', error: '' }
        const r = await call('panel.ports')
        if (r && r.ok && r.detected) {
          setPortInfo(r.detected)
          setHasBoard(true)
          rep.port = r.detected.port
          setStatus({ state: 'busy', text: '读取板子信息…' })
          const info = await call('panel.info')
          if (info && info.ok) {
            connectedLive = true
            setConnected(true)
            setStatus({ state: 'ok', text: '已连接 ' + r.detected.port + ' @ ' + (info.baud || 12000000) })
            if (info.text) appendDebug(info.text)
            rep.ok = true
            rep.status = 'connected'
          } else {
            connectedLive = false
            setConnected(false)
            setStatus({ state: 'err', text: '连接失败: ' + ((info && info.error) || '未知错误') })
            rep.status = 'info failed'
            rep.error = (info && info.error) || '未知错误'
          }
        } else if (r && r.ok) {
          connectedLive = false
          setConnected(false)
          setStatus({ state: 'err', text: '未找到 CanMV K230 板（VID 1209:ABD1）' })
          rep.status = 'no board'
        } else {
          connectedLive = false
          setConnected(false)
          setStatus({ state: 'err', text: (r && r.error) || '端口枚举失败' })
          rep.status = 'ports failed'
          rep.error = (r && r.error) || '端口枚举失败'
        }
        busyLive = false
        setBusy(false)
        host.call('panel.ping', rep).catch(() => {})
      }

      async function runInfo() {
        if (busy) return
        busyLive = true
        setBusy(true)
        setStatus({ state: 'busy', text: '读取信息…' })
        const r = await call('panel.info')
        if (r && r.ok) {
          if (r.text) appendDebug(r.text)
          markConnected(r.port)
          setStatus({ state: 'ok', text: '信息已更新' + (r.port ? '（' + r.port + '）' : '') })
        } else {
          setStatus({ state: 'err', text: (r && r.error) || '读取失败' })
        }
        busyLive = false
        setBusy(false)
      }

      async function runReset() {
        if (busy) return
        busyLive = true
        setBusy(true)
        setStatus({ state: 'busy', text: '软复位中…' })
        const r = await call('panel.reset')
        if (r && r.ok) {
          if (r.text) appendDebug('—— 复位启动信息 ——\n' + r.text)
          markConnected(r.port)
          setStatus({ state: 'ok', text: '已复位并重新连接' })
        } else {
          setStatus({ state: 'err', text: '复位失败: ' + ((r && r.error) || '未知错误') })
        }
        busyLive = false
        setBusy(false)
      }

      async function runStart() {
        if (busy) return
        if (session && session.active) { statusLine('[提示] 脚本已在运行'); return }
        if (!runCode) {
          statusLine('[提示] 请先点击「📂 打开脚本」选择 .py 文件，或把 .py 文件拖到面板上载入')
          return
        }
        disconnectedLive = false
        busyLive = true
        setBusy(true)
        setStarting(true)
        runStartedAtLive = Date.now()
        setStatus({ state: 'busy', text: '启动脚本会话（板子软复位 + 运行，约 12 秒）…' })
        previewEnabledLive = false
        setPreviewOn(false)
        setFrame(null)
        const payload = { codeB64: b64EncodeUtf8(runCode), codeHead: runCode.slice(0, 48) }
        const r = await call('panel.run.start', payload)
        if (r && r.ok) {
          statusLine('[运行] 脚本已发送（' + r.port + '）')
          markConnected(r.port)
          // v12.18：运行成功后挂起自动预览——poll 看到【新鲜】的 started 后真正开启
          autoPreviewLive = true
          setStatus({ state: 'run', text: '脚本运行中（' + r.port + '）' })
        } else {
          statusLine('[错误] ' + ((r && r.error) || '启动失败'))
          setStatus({ state: 'err', text: '启动失败' })
        }
        busyLive = false
        setBusy(false)
        setStarting(false)
      }

      async function runStop() {
        if (busy) return
        busyLive = true
        setBusy(true)
        autoPreviewLive = false
        const r = await call('panel.run.stop')
        if (r && r.ok) {
          previewEnabledLive = false
          setPreviewOn(false)
          setFrame(null)
          if (r.stopped) { statusLine('[停止] 已发送停止指令'); setStatus({ state: 'busy', text: '正在停止…' }) }
        }
        busyLive = false
        setBusy(false)
      }

      // v12.12：断开连接——停止运行中的会话（如有）、清除端口缓存、回到"未连接"
      async function disconnect() {
        if (busy) return
        busyLive = true
        setBusy(true)
        autoPreviewLive = false
        const r = await call('panel.disconnect')
        connectedLive = false
        setConnected(false)
        disconnectedLive = true
        sessionActiveLive = false
        previewEnabledLive = false
        setPreviewOn(false)
        setFrame(null)
        setSession(null)
        setPortInfo(null)
        setStatus({ state: 'idle', text: '未连接' })
        statusLine(r && r.stopped ? '[断开] 已停止脚本并断开连接' : '[断开] 已断开连接')
        busyLive = false
        setBusy(false)
      }

      async function togglePreview() {
        if (!session || !session.active) {
          statusLine('[提示] 请先「运行脚本」（预览需要脚本在运行中）')
          return
        }
        if (previewOn) {
          // v12.19：挂起中再次点击 = 取消挂起
          if (autoPreviewLive) {
            autoPreviewLive = false
            setPreviewOn(false)
            statusLine('[预览] 已取消挂起')
            return
          }
          const r = await call('panel.preview.off')
          if (r && r.ok) { previewEnabledLive = false; previewWarnedLive = false; setPreviewOn(false); setFrame(null); statusLine('[预览] 已停止') }
          return
        }
        // v12.19：打开预览——板子还没真正跑起来（状态文件还是旧的）时先挂起，
        // 等 poll 看到新鲜 started 后自动发送；否则预览指令会被会话启动清理吞掉。
        const st = session && session.status
        const fresh = !!(st && st.started === true && typeof st.at === 'number' && st.at > runStartedAtLive)
        if (!fresh) {
          autoPreviewLive = true
          setPreviewOn(true)
          statusLine('[预览] 已挂起——等板子启动后自动开启')
          return
        }
        const r = await call('panel.preview.on')
        if (r && r.ok) {
          previewEnabledLive = true
          previewWarnedLive = false
          previewArmedAtLive = Date.now()
          setPreviewOn(true)
          statusLine('[预览] 已开启（等待首帧…）')
        } else {
          statusLine('[错误] ' + ((r && r.error) || '开启预览失败'))
        }
      }

      // v12.17：载入脚本——资源管理器选择（label 包隐藏 input）或拖放。
      // 浏览器 File.text() 直接读取（UTF-8），不依赖任何沙箱全局。
      async function loadFileObject(file) {
        if (!file) return
        const name = file && file.name ? String(file.name) : '未命名文件'
        if (!name.toLowerCase().endsWith('.py')) {
          statusLine('[错误] 只支持 .py 脚本文件（收到: ' + name + '）')
          return
        }
        if (file.size !== undefined && file.size > 2 * 1024 * 1024) {
          statusLine('[错误] 文件过大（' + Math.round(file.size / 1024) + 'KB，上限 2MB）')
          return
        }
        try {
          if (typeof file.text !== 'function') {
            statusLine('[错误] 当前浏览器不支持 File.text()，无法读取文件')
            return
          }
          const text = await file.text()
          setRunCode(text)
          setLoadedFile(name)
          statusLine('[载入] ' + name + '（' + text.length + ' 字符）')
        } catch (err) {
          statusLine('[错误] 读取文件失败: ' + String((err && err.message) || err))
        }
      }

      function onFilePicked(e) {
        try {
          const f = e && e.target && e.target.files && e.target.files[0]
          loadFileObject(f)
          if (e && e.target) e.target.value = ''
        } catch (err) {}
      }

      function onPanelDragOver(e) {
        try {
          e.preventDefault()
          if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy'
        } catch (err) {}
        setDragOver(true)
      }
      function onPanelDragLeave(e) {
        try {
          if (e.currentTarget && e.relatedTarget && e.currentTarget.contains(e.relatedTarget)) return
        } catch (err) {}
        setDragOver(false)
      }
      function onPanelDrop(e) {
        try { e.preventDefault() } catch (err) {}
        setDragOver(false)
        try {
          const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0]
          loadFileObject(f)
        } catch (err) {
          statusLine('[错误] 拖放读取失败: ' + String((err && err.message) || err))
        }
      }

      // v12.15：端口枚举 tick——仅在未连接且不忙时每 2 秒枚举一次，
      // 让连接/断开双态键跟随"板子是否存在"变化。
      async function enumTick() {
        if (connectedLive || busyLive) return
        try {
          const r = await call('panel.ports')
          if (!r || !r.ok) {
            setEnumErr((r && r.error) || '端口枚举失败')
            return
          }
          setEnumErr('')
          if (r.detected) {
            setHasBoard(true)
            setPortInfo(r.detected)
          } else {
            setHasBoard(false)
            setPortInfo(null)
          }
        } catch (e) {
          setEnumErr(String((e && e.message) || e))
        }
      }

      async function pollTick() {
        try {
          const p = await call('panel.run.poll')
          if (!p || !p.ok) return
          const wasActive = sessionActiveLive
          sessionActiveLive = !!(p && p.active)
          if (p.active) {
            connectedLive = true
            setConnected(true)
          }
          // v12.19：自动预览——必须等【本次运行之后】的新状态文件（status.at 晚于
          // 点击运行的时刻）且 started=true，才发 preview.on；旧状态文件残留的
          // started:true 会误导提前发送，被会话 PS 启动阶段的 cmd.json 清理吞掉。
          if (autoPreviewLive && p.active && p.status) {
            const fresh = p.status.started === true &&
              typeof p.status.at === 'number' && p.status.at > runStartedAtLive
            if (fresh) {
              autoPreviewLive = false
              const pr = await call('panel.preview.on')
              if (pr && pr.ok) {
                previewEnabledLive = true
                previewWarnedLive = false
                previewArmedAtLive = Date.now()
                setPreviewOn(true)
                statusLine('[预览] 已自动开启（等待首帧…）')
              } else {
                setPreviewOn(false)
                statusLine('[错误] 自动开启预览失败: ' + ((pr && pr.error) || '未知错误'))
              }
            } else if (Date.now() - runStartedAtLive > 45000) {
              autoPreviewLive = false
              setPreviewOn(false)
              statusLine('[提示] 45 秒内脚本未启动，预览未自动开启（可在运行时手动点「👁 预览」）')
            }
          }
          // v12.19 看门狗：preview.on 已发但 15 秒后板子仍未回应（fb=false，
          // 说明指令可能在启动阶段被吞或 PS 未处理）——自动重发一次。
          if (previewEnabledLive && !previewWarnedLive && previewArmedAtLive > 0 &&
              Date.now() - previewArmedAtLive > 15000) {
            previewWarnedLive = true
            if (!p.status || p.status.fb !== true) {
              const pr2 = await call('panel.preview.on')
              statusLine(pr2 && pr2.ok
                ? '[预览] 板子 15 秒未回应抓帧指令，已自动重发一次'
                : '[错误] 重发预览指令失败: ' + ((pr2 && pr2.error) || '未知错误'))
            }
          }
          // v12.22：帧冻结提示（板子显示管线失效，画面停止更新但连接正常）
          if (p.status && p.status.frameStall === true && !stallWarnedLive) {
            stallWarnedLive = true
            statusLine('[警告] 帧冻结：板子显示管线已失效，画面停止更新（连接本身正常）——可停止后重新运行脚本')
          }
          if (p.status && p.status.frameStall !== true) stallWarnedLive = false
          if (wasActive && !p.active && p.status && p.status.done) {
            if (!disconnectedLive) {
              statusLine('[结束] 脚本已结束（frames=' + ((p.status && p.status.frames) || 0) + '）')
              if (p.status.started === false) statusLine('[提示] 脚本从未启动——v12.5 已修复中文脚本编码问题，请再试一次；若仍失败请把日志发给助手')
              setStatus({ state: 'ok', text: '脚本已结束' })
            }
            autoPreviewLive = false
            previewEnabledLive = false
            setPreviewOn(false)
            setFrame(null)
          }
          setSession({ active: !!p.active, status: p.status, expiresInMs: p.expiresInMs, port: p.port })
          if (p.newOutput) routeOutput(p.newOutput)
          if (previewEnabledLive) {
            const f = await call('panel.preview.frame')
            if (f && f.ok && f.available) {
              setFrame(prev => {
                if (!prev || prev.frameId !== f.frameId) {
                  return { frameId: f.frameId, w: f.w, h: f.h, bytes: f.bytes, b64: f.b64, at: f.at }
                }
                return prev
              })
            }
          }
        } catch (e) {}
      }

      React.useEffect(() => {
        // v12.12：不再自动连接（用户要求）
        // v12.15：另起 2 秒一次的端口枚举 tick（仅未连接且不忙时枚举）
        // v12.17：脚本不再从 code 文件夹列表载入（资源管理器/拖放）
        enumTick()
        const d1 = ctx.timer.interval(() => { pollTick() }, 450)
        const d2 = ctx.timer.interval(() => { enumTick() }, 2000)
        return () => {
          if (typeof d1 === 'function') d1()
          if (typeof d2 === 'function') d2()
        }
      }, [])

      function onHeaderDown(e) {
        // v12.13：忽略来自按钮/表单控件的按下事件，避免指针捕获吞掉
        // 它们的 click（收起按钮此前因此失效）
        try {
          if (e.target && e.target.closest && e.target.closest('button, select, textarea, input, label')) return
        } catch (err) {}
        try { e.currentTarget.setPointerCapture(e.pointerId) } catch (err) {}
        setDrag({ startX: e.clientX, startY: e.clientY, baseX: pos.x, baseY: pos.y })
      }
      function onHeaderMove(e) {
        if (!drag) return
        setPos({
          x: Math.max(0, drag.baseX + (drag.startX - e.clientX)),
          y: Math.max(0, drag.baseY + (e.clientY - drag.startY)),
        })
      }
      function onHeaderUp() { setDrag(null) }

      const sessionInfo = session && session.active && session.status
        ? ('脚本' + (session.status.scriptRunning ? '运行中' : '结束') + (session.status.fb ? ' · 预览中' : '') +
          (session.status.frameStall ? ' · ⚠帧冻结' : '') +
          (session.expiresInMs > 0 ? ' · 剩余 ' + Math.round(session.expiresInMs / 60000) + ' 分钟' : ''))
        : ''

      // v12.15：双态判定
      const isConnected = connected || !!(session && session.active)
      const running = !!(session && session.active)
      const runReady = !running && !busy && !!runCode

      // 未连接且空闲时，状态行跟随端口枚举结果显示可操作性
      let statusText = status.text
      if (!isConnected && status.state === 'idle') {
        statusText = enumErr
          ? ('未连接 · ' + enumErr)
          : (hasBoard ? '未连接 · 发现 CanMV 开发板' : '未连接 · 未发现 CanMV 开发板')
      }

      // v12.23：设置页关掉悬浮窗时整个面板（含收起药丸）不渲染
      if (!visible) return null

      if (!open) {
        return React.createElement('div',
          { className: 'cmv-pill', style: { right: pos.x, top: pos.y }, onClick: () => setOpen(true), title: '展开 CanMV 面板' },
          React.createElement('span', { className: 'cmv-dot cmv-' + (previewOn ? 'run' : status.state) }),
          React.createElement('span', null, 'CanMV K230' + (previewOn ? ' ●' : '')),
        )
      }

      return React.createElement('div', {
        className: 'cmv-panel' + (dragOver ? ' cmv-drop' : ''),
        style: { right: pos.x, top: pos.y },
        onDragOver: onPanelDragOver,
        onDragLeave: onPanelDragLeave,
        onDrop: onPanelDrop,
      },
        React.createElement('div', {
          className: 'cmv-header',
          onPointerDown: onHeaderDown,
          onPointerMove: onHeaderMove,
          onPointerUp: onHeaderUp,
        },
          React.createElement('span', { className: 'cmv-dot cmv-' + (previewOn ? 'run' : status.state) }),
          React.createElement('span', { className: 'cmv-title' }, 'CanMV K230'),
          React.createElement('span', { className: 'cmv-port' }, portInfo ? portInfo.port : ''),
          React.createElement('button', {
            className: 'cmv-x',
            onClick: () => setOpen(false),
            onPointerDown: e => { try { e.stopPropagation() } catch (err) {} },
            title: '收起',
          }, '—'),
        ),
        React.createElement('div', { className: 'cmv-body' },
          React.createElement('div', { className: 'cmv-status' }, (sessionInfo ? sessionInfo + ' | ' : '') + statusText),
          React.createElement('div', { className: 'cmv-btns' },
            // v12.15：双态连接/断开键——未连接且枚举发现板子时绿色可点，
            // 未发现板子时禁用并提示；已连接时显示红色「断开」。
            React.createElement('button', {
              className: isConnected ? 'danger' : (hasBoard ? 'on' : ''),
              onClick: isConnected ? disconnect : connect,
              disabled: isConnected ? busy : (busy || !hasBoard),
              title: isConnected
                ? '断开连接'
                : (hasBoard ? '连接 ' + (portInfo ? portInfo.port : '') : '未发现 CanMV K230 板（VID 1209:ABD1）'),
            }, isConnected ? '断开' : '连接'),
            React.createElement('button', { onClick: runInfo, disabled: busy || running }, '信息'),
            React.createElement('button', { onClick: runReset, disabled: busy || running }, '复位'),
            // v12.21：清屏同时清面板状态与开发板调试两个框
            React.createElement('button', { onClick: () => { setDebugLog(''); setStatusLog('') } }, '清屏'),
          ),
          // v12.17：脚本载入——资源管理器选择（label 包隐藏 input）+ 拖放
          React.createElement('div', { className: 'cmv-btns' },
            React.createElement('label', { className: 'cmv-file', title: '从资源管理器选择 .py 脚本' },
              '📂 打开脚本…',
              React.createElement('input', {
                type: 'file',
                accept: '.py,text/x-python-script,text/x-python',
                onChange: onFilePicked,
              }),
            ),
            React.createElement('span', { className: 'cmv-loaded', title: loadedFile || '未载入脚本' },
              loadedFile ? ('已载入: ' + loadedFile) : '未载入脚本'),
          ),
          React.createElement('div', { className: 'cmv-hint' }, '或把 .py 文件拖到面板上载入'),
          React.createElement('div', { className: 'cmv-btns' },
            // v12.15：双态运行/停止键——运行中显示红色「■ 停止」，
            // 否则显示「▶ 运行脚本」（已载入脚本时绿色可点，启动期间显示「启动中…」）。
            React.createElement('button', {
              className: running ? 'danger' : (runReady ? 'on' : ''),
              onClick: running ? runStop : runStart,
              disabled: running ? busy : (busy || !runCode),
              title: running
                ? '停止脚本'
                : (runCode ? '运行已载入的脚本' : '请先打开或拖入 .py 脚本'),
            }, running ? '■ 停止' : (starting ? '启动中…' : '▶ 运行脚本')),
            React.createElement('button', {
              className: previewOn ? 'on' : '',
              onClick: togglePreview,
              disabled: !running,
            }, previewOn ? '预览中（点击停止）' : '👁 预览'),
          ),
          previewOn ? React.createElement('div', { className: 'cmv-preview-box' },
            frame ? React.createElement('img', { src: 'data:image/jpeg;base64,' + frame.b64, alt: 'preview' })
              : React.createElement('div', { className: 'cmv-preview-hint' }, '等待首帧…'),
            frame ? React.createElement('div', { className: 'cmv-preview-hint', style: { inset: 'auto 6px 4px auto', color: 'rgba(255,255,255,.75)', background: 'rgba(0,0,0,.4)', padding: '1px 6px', borderRadius: '4px' } },
              frame.w + '×' + frame.h + ' · #' + frame.frameId + ' · ' + (frame.bytes / 1024).toFixed(1) + 'KB') : null,
          ) : null,
          // v12.21：面板状态小框（上）与开发板调试大框（下）分开——状态不进调试框
          React.createElement('div', { className: 'cmv-boxhead' }, '面板状态'),
          React.createElement('pre', { className: 'cmv-status-log' }, statusLog || '— 暂无状态 —'),
          React.createElement('div', { className: 'cmv-boxhead' }, '开发板调试'),
          React.createElement('pre', { className: 'cmv-log' }, debugLog || '— 无调试输出 —'),
        ),
      )
    }

    // ---------------- v12.23：CanMV 设置页（开关悬浮窗） ----------------
    function CanmvSettingsPage() {
      const [visible, setVisible] = usePanelVisible()
      const btnStyle = {
        background: 'var(--dsw-alias-bg-layer-2)',
        border: '1px solid ' + (visible ? 'var(--dsw-alias-state-success-primary)' : 'var(--dsw-alias-border-l2)'),
        color: visible ? 'var(--dsw-alias-state-success-primary)' : 'var(--dsw-alias-label-secondary)',
        borderRadius: '8px', padding: '5px 12px', cursor: 'pointer', fontSize: '12px',
      }
      return React.createElement('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '12px', padding: '4px 0' } },
        React.createElement('div', null,
          React.createElement('div', { style: { fontWeight: 600, fontSize: '13px' } }, 'CanMV K230 悬浮面板'),
          React.createElement('div', { style: { color: 'var(--dsw-alias-label-secondary)', fontSize: '11px', marginTop: '2px' } },
            visible ? '当前：显示（右上角）' : '当前：隐藏（如需使用请重新开启）'),
        ),
        React.createElement('button', {
          style: btnStyle,
          onClick: () => setVisible(!visible),
          title: visible ? '隐藏悬浮面板' : '显示悬浮面板',
        }, visible ? '隐藏' : '显示'),
      )
    }

    slots.inject('settings.section', () => slots.register(
      { name: 'settings.section', id: 'canmv', order: 30, label: 'CanMV' },
      () => React.createElement(CanmvSettingsPage),
    ))

    slots.inject('shell.overlay', () => slots.register(
      { name: 'shell.overlay', id: 'canmv-k230-panel', order: 50, label: 'CanMV K230 面板' },
      () => React.createElement(Panel),
    ))
  },
}

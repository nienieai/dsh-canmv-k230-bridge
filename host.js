// ============================================================================
// CanMV K230 bridge — Host 端动态 Cordis 插件源码（v12.18 = v12.17 + 采纳会话退出感知兜底）
// 来源：v10 来自 canmv-1/pkg-12（"CanMV K230 bridge v10"），由本会话实测逆向并验证；
//       v12 新增官方 USBDBG 协议的活动会话（SCRIPT_EXEC 运行脚本 + TX_BUF 输出流 +
//       FB_ENABLE/FRAME_SIZE/FRAME_DUMP 预览），协议实现对照 kendryte/canmv-vscode-extension 源码。
// 用途：11 个模型工具 + 悬浮面板（连接/信息/复位/快速执行/运行脚本/预览/脚本载入）。
// v12.6：Drain-Tx/FRAME 读失步时用 QUERY_STATUS magic 重新同步（对照官方
//       recoverStreamDesync）；预览空帧每 10 次重发 FB_ENABLE（对照官方
//       refreshFramebufferFor）；会话日志增加 SESSION bytes/head 诊断；
//       run.start 记录 code/b64 长度与头部；会话崩溃未写 done 时由 Host 补 done。
//       探针 probe7 实测：VIRT 640x480 与 ST7701 480x800 均能出帧，中文 UTF-8 正常。
// v12.7：面板载荷走 ASCII-safe base64（codeB64）+ 旧字段逆变换修复。
// v12.8：run.start 载荷落盘诊断（runstart-diag.json / session-diag.json）+ 交付前保险带。
// v12.9：交付自校验——脚本改唯一文件名 script-<ts>.b64（杜绝共享 script.b64 被并发写者
//       换掉的竞争）；会话按预期字节数校验文件（不匹配重试 10 次×800ms，仍不匹配则拒绝
//       交付，绝不把垃圾送到板子）；写入后回读校验（writediag.json）；会话把 $PID 写
//       session-pid.json，下次启动先强杀僵尸会话进程（根治 COM 口占用）；新增模型工具
//       canmv_runfile（本地 code 文件走同一会话交付路径，助手可直接驱动诊断）。
// v12.13：存活判定加固——QUERY_STATUS 连续 0 判定脚本结束的阈值从 2 次放宽到 6 次
//       （约 3~5 秒），重负载脚本（绿植检测：摄像头+LVGL）USB 应答偶发卡顿 1~2 秒
//       不再误判"脚本已结束"（面板表现：过一会儿自己断开/预览关闭）；会话串口写超时
//       5s→15s，防止板子忙时写超时异常误杀会话进程。
// v12.14：新增 4 个模型工具——canmv_frame（取最新预览帧：帧号/分辨率/字节数/时间戳 +
//       runtime\latest.jpg 本地路径，配合 read_image 工具直接看画面）、canmv_preview
//       （开/关预览抓帧）、canmv_session（会话状态 + 输出日志尾部）、canmv_stop
//       （停止当前会话，与面板「停止」等效）。工具与面板共用 runtime 文件与 lock()
//       串行化；execute 一律直接 async（内部函数自带锁，不得再套 lockExecute，
//       避免 v12.10 的链式锁死锁）。
// v12.15：会话循环异常加固（12 分钟耐久测试实测：板子 USB 短暂停顿 >15 秒写超时，
//       在 $ErrorActionPreference='Stop' 下直接杀死会话 PS，status.json 无 done 标志
//       残留，面板表现为"莫名断开"）。修复：主循环体包 try/catch——单次异常记
//       output.log（SESSION LOOP ERROR n=...）后继续，连续 10 次才判定会话死亡；
//       正常迭代重置计数；收尾段（FB off / SCRIPT_STOP / 末次 Drain-Tx）也包
//       try/catch，且 done 状态【必然】写出（含 loopErrors 计数），杜绝状态文件
//       冻结残留。状态文件新增 loopErrors 字段，canmv_session 一并显示。
// v12.16：会话"10 分钟被杀"根治（两次耐久测试实测：~10.5 分钟会话 PS 必然死亡，
//       无异常、无系统事件、loopErrors=0——定位到 DSH shell 服务：shell.run() 的
//       timeoutMs 会被部署默认 maxTimeoutMs=600000（10 分钟）钳制，任何前台命令
//       到点即被杀，这就是用户报告"延时断开"的真正根因）。修复：会话改为
//       shell.start() 后台进程启动——后台进程无超时（模型 pwsh 工具的后台任务
//       实测可跑 15 分钟以上），会话真正"不限时"；同时新增"既有会话采纳"：
//       插件更新/重载后从 session-pid.json 认领仍在运行的后台会话（pid 存活、
//       status 非 done 即采纳），杜绝孤儿会话；session-pid.json 增加 baud 字段。
// v12.17：帧冻结哨兵（超长连接实测：脚本跑了 ~2.5 小时后板子侧显示管线死亡——
//       帧缓冲不再出数据，但 QUERY_STATUS 仍应答、会话进程健康、loopErrors=0，
//       预览图片静默定格，连接却"正常"。此前 FRAME_SIZE 无应答分支是静默跳过的）。
//       修复：1) FRAME_SIZE 无应答/空帧计数并记日志，连续 10 次自动 FB off/on 重新武装；
//       2) 60 秒无新帧判定"帧冻结"（frameStall=true 写入 status.json，附 lastFrameAt），
//       每 60 秒自动尝试 FB off/on 恢复，恢复后自动清零；3) canmv_session 显示
//       "帧冻结/最后帧时间"，面板状态行显示 ⚠帧冻结并提示一次。
// v12.18：采纳会话退出感知兜底（实测：v12.16 采纳的会话没有进程句柄（proc=null），
//       proc.done 永不触发——停止后 session.active 卡死为 true，新会话被拒。
//       修复：poll 里对 proc=null 的活动会话做节流 pidAlive 轮询（每 5 秒一次），
//       进程退出后清除活动状态并记日志）。
// 恢复方法（动态插件）：在会话中用 cordis_define（kind:"new", idPrefix:"canmv"）
//       把本文件全部内容作为 code.host、client.js 作为 code.client 提交，再 cordis_run。
// 依赖：Host 组合需挂载 shell（PowerShell 后端，Windows）、sandboxPolicy、fs。
// ============================================================================

const DEFAULT_BAUD = 115200
const CANMV_BAUD = 12000000
const B64_CHUNK = 1024
const BATCH = 4
const MAX_UPLOAD = 4 * 1024 * 1024
const MAX_EXEC = 8000
const B64_ALPHA = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'

function psq(value) {
  return "'" + String(value).replace(/'/g, "''") + "'"
}

function psh(value) {
  return "@'\n" + String(value) + "\n'@"
}

function pyq(value) {
  return JSON.stringify(String(value))
}

function normBoardPath(value) {
  let s = String(value).replace(/\\/g, '/').trim()
  if (s.length === 0) throw new Error('board path must not be empty')
  if (s !== '/') s = s.replace(/\/+$/, '')
  return s
}

function bytesToB64(u8) {
  let out = ''
  for (let i = 0; i < u8.length; i += 3) {
    const a = u8[i]
    const b = i + 1 < u8.length ? u8[i + 1] : -1
    const c = i + 2 < u8.length ? u8[i + 2] : -1
    out += B64_ALPHA[a >> 2]
    out += B64_ALPHA[((a & 3) << 4) | (b < 0 ? 0 : b >> 4)]
    out += b < 0 ? '=' : B64_ALPHA[((b & 15) << 2) | (c < 0 ? 0 : c >> 6)]
    out += c < 0 ? '=' : B64_ALPHA[c & 63]
  }
  return out
}

function parsePaste(raw) {
  const complete = raw.endsWith('>>> ')
  let s = raw
  const idx = s.lastIndexOf('=== ')
  if (idx >= 0) s = s.slice(idx + 4)
  s = s.replace(/^\s+/, '')
  if (s.endsWith('>>> ')) s = s.slice(0, -4)
  s = s.replace(/[\r\n]+$/, '')
  return { text: s, complete: complete }
}

// ---------------- v12.7：UTF-8 传输加固 ----------------
// 实测定位：面板「运行脚本」交付到板子的脚本被变换为
// latin1Decode(utf8Encode(原文))（交付 97896 字节与源文件逐位比对确认），
// 中文全部变成 ç»¿æ¤ 式乱码。文件读取（fs.readText 严格 UTF-8）干净，
// 变换发生在 Client→Host RPC 的某个环节。修复策略：
//   1. 面板载荷优先走 ASCII-safe base64（codeB64）——纯 ASCII 对
//      Latin-1 变换是恒等变换，天然免疫；
//   2. 旧字段（code 原文）回退时做逆变换 repairMojibake（Latin-1 字节串
//      → 严格 UTF-8 解码），非 mojibake 文本原样保留。
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

// 从面板 RPC 参数取脚本文本：优先 codeB64（宿主 atob 内建 UTF-8 解码），
// 旧字段 code 走逆变换修复。
function codeFromArgs(args) {
  if (args && typeof args.codeB64 === 'string' && args.codeB64.length > 0) {
    try { return atob(args.codeB64) } catch (e) {}
  }
  if (args && typeof args.code === 'string') return repairMojibake(args.code)
  return ''
}

// ---------------- v12.11：纯字节级 UTF-8→base64（根治 btoa 双重编码） ----------------
// 实测铁证（writediag.json 2026-08-15）：宿主沙箱的 btoa 是 UTF-8 感知实现，
// btoa(unescape(encodeURIComponent(中文))) 会把已产出的字节串再按 UTF-8 编码一遍
// （0xE7→C3 A7），板子收到 97896 字节乱码（v12.5~v12.10 全部交付乱码的真凶）。
// 修复：一律用纯 JS 字节级编码器 utf8B64()（bytesToB64 已存在且经预览 JPEG 验证），
// 不再依赖环境 btoa 的语义。b64ByteLen() 按 4→3 规则计算 base64 承载的字节数，
// 用于交付前自查（写入内容必须恰好承载 utf8Len 个字节，杜绝未来再次双编码）。
function utf8B64(s) {
  const bs = unescape(encodeURIComponent(String(s)))
  const u8 = new Array(bs.length)
  for (let i = 0; i < bs.length; i++) u8[i] = bs.charCodeAt(i) & 0xFF
  return bytesToB64(u8)
}

function b64ByteLen(b64) {
  const s = String(b64).replace(/[^A-Za-z0-9+/]/g, '')
  if (s.length === 0) return 0
  const full = Math.floor(s.length / 4) * 3
  const rem = s.length % 4
  if (rem === 0) return full
  if (rem === 3) return full + 2
  if (rem === 2) return full + 1
  return -1
}

function opPaste(code, ms) {
  const b64 = utf8B64(code)
  const line = 'import ubinascii as _b; exec(_b.a2b_base64(' + psq(b64) + '))'
  return [
    '$code = ' + psh(line),
    '$out = R-Paste $code ' + Number(ms),
    "Write-Output ('__OUT__' + [Convert]::ToBase64String([System.Text.Encoding]::UTF8.GetBytes($out)))"
  ]
}

function opChunk(line, ms) {
  return [
    '$code = ' + psh(line),
    '$out = R-Paste $code ' + Number(ms),
    "Write-Output ('__OUT__' + [Convert]::ToBase64String([System.Text.Encoding]::UTF8.GetBytes($out)))"
  ]
}

const PORTS_SCRIPT = [
  "$ErrorActionPreference = 'Stop'",
  '$map = @{}',
  'try {',
  "  $sc = Get-ItemProperty 'HKLM:\\HARDWARE\\DEVICEMAP\\SERIALCOMM' -ErrorAction Stop",
  '  foreach ($pr in $sc.PSObject.Properties) {',
  "    if ($pr.Value -match '^COM\\d+$' -and $pr.Name -like '\\Device\\*') { $map[$pr.Value] = [string]$pr.Name }",
  '  }',
  '} catch {}',
  'try {',
  '  foreach ($p in [System.IO.Ports.SerialPort]::GetPortNames()) {',
  "    if (-not $map.ContainsKey($p)) { $map[$p] = " + psq('') + ' }',
  '  }',
  '} catch {}',
  '$usb = @{}',
  '$vid = @{}',
  'try {',
  "  Get-ChildItem 'HKLM:\\SYSTEM\\CurrentControlSet\\Enum\\USB' -ErrorAction SilentlyContinue | ForEach-Object {",
  '    $vidkey = [string]$_.PSChildName',
  '    Get-ChildItem $_.PSPath -ErrorAction SilentlyContinue | ForEach-Object {',
  '      $ip = Get-ItemProperty $_.PSPath -ErrorAction SilentlyContinue',
  '      if ($ip.FriendlyName) {',
  "        if ([string]$ip.FriendlyName -match '\\(COM(\\d+)\\)') {",
  "          $cn = 'COM' + $Matches[1]",
  '          $usb[$cn] = [string]$ip.FriendlyName',
  '          $vid[$cn] = $vidkey',
  '        }',
  '      }',
  '    }',
  '  }',
  '} catch {}',
  '$rows = @()',
  'foreach ($k in ($map.Keys | Sort-Object { [int]($_.Substring(3)) })) {',
  '  $desc = ' + psq(''),
  '  $dev = [string]$map[$k]',
  '  if ($usb.ContainsKey($k)) { $desc = [string]$usb[$k] }',
  '  elseif ($dev -like ' + psq('\\Device\\BthModem*') + ') { $desc = ' + psq('Bluetooth modem (virtual)') + ' }',
  '  elseif ($dev -like ' + psq('\\Device\\USBSER*') + ') { $desc = ' + psq('USB CDC-ACM serial (usbser)') + ' }',
  '  elseif ($dev -like ' + psq('\\Device\\Serial*') + ') { $desc = ' + psq('standard COM device') + ' }',
  '  $devid = $dev',
  "  if ($vid.ContainsKey($k)) { $devid = $devid + ' | USB:' + $vid[$k] }",
  '  $rows += [pscustomobject]@{ port = $k; desc = $desc; deviceid = $devid }',
  '}',
  "$json = '[]'",
  'if ($rows.Count -gt 0) { $json = ($rows | ConvertTo-Json -Compress) }',
  "Write-Output ('__OUT__' + [Convert]::ToBase64String([System.Text.Encoding]::UTF8.GetBytes($json)))"
].join('\n')

function sessionScript(port, baud, opLines) {
  return [
    "$ErrorActionPreference = 'Stop'",
    '$port = New-Object System.IO.Ports.SerialPort(' + psq(port) + ', ' + Number(baud) + ', [System.IO.Ports.Parity]::None, 8, [System.IO.Ports.StopBits]::One)',
    '$port.Encoding = [System.Text.Encoding]::UTF8',
    '$port.ReadTimeout = 200',
    '$port.WriteTimeout = 3000',
    '$port.DtrEnable = $false',
    '$port.RtsEnable = $false',
    '$port.Open()',
    'Start-Sleep -Milliseconds 150',
    '$port.DtrEnable = $true',
    'Start-Sleep -Milliseconds 150',
    '$port.DtrEnable = $false',
    'Start-Sleep -Milliseconds 100',
    '$port.DtrEnable = $true',
    '$buf = New-Object System.Text.StringBuilder',
    'function R-Read([int]$ms) {',
    '  $deadline = [DateTime]::UtcNow.AddMilliseconds($ms)',
    '  while ([DateTime]::UtcNow -lt $deadline) {',
    '    $chunk = $port.ReadExisting()',
    '    if ($chunk.Length -gt 0) { $null = $buf.Append($chunk) }',
    '    else { Start-Sleep -Milliseconds 10 }',
    '  }',
    '}',
    'function R-Wait([string]$needle, [int]$ms) {',
    '  $deadline = [DateTime]::UtcNow.AddMilliseconds($ms)',
    '  while ([DateTime]::UtcNow -lt $deadline) {',
    '    $chunk = $port.ReadExisting()',
    '    if ($chunk.Length -gt 0) { $null = $buf.Append($chunk) }',
    '    $text = $buf.ToString()',
    '    $idx = $text.IndexOf($needle)',
    '    if ($idx -ge 0) {',
    '      $consumed = $text.Substring(0, $idx + $needle.Length)',
    '      $null = $buf.Remove(0, $idx + $needle.Length)',
    '      return $consumed',
    '    }',
    '    Start-Sleep -Milliseconds 10',
    '  }',
    '  $left = $buf.ToString()',
    '  $null = $buf.Clear()',
    '  return $left',
    '}',
    'function Enter-Paste() {',
    '  $port.Write(([string][char]5))',
    '  $b = R-Wait ' + psq('paste mode') + ' 2500',
    '  if ($b.Contains(' + psq('paste mode') + ')) { return }',
    '  $port.Write(([string][char]3))',
    '  $p = R-Wait ' + psq('>>> ') + ' 12000',
    '  if (-not $p.Contains(' + psq('>>> ') + ')) {',
    '    $port.Write(([string][char]2))',
    '    $p2 = R-Wait ' + psq('>>> ') + ' 12000',
    '    $port.Write(([string][char]5))',
    '    $b = R-Wait ' + psq('paste mode') + ' 3000',
    '    if (-not $b.Contains(' + psq('paste mode') + ')) {',
    '      $tail = $p + $p2 + $b',
    '      if ($tail.Length -gt 4000) { $tail = $tail.Substring($tail.Length - 4000) }',
    '      throw (' + psq('paste mode not entered, board output: ') + ' + $tail)',
    '    }',
    '    return',
    '  }',
    '  $port.Write(([string][char]5))',
    '  $b = R-Wait ' + psq('paste mode') + ' 3000',
    '  if (-not $b.Contains(' + psq('paste mode') + ')) {',
    '    throw (' + psq('paste mode not entered, board output: ') + ' + $p + $b)',
    '  }',
    '}',
    'function R-Paste([string]$code, [int]$ms) {',
    '  Enter-Paste',
    '  $norm = $code -replace ' + psq('\\r?\\n') + ', "`r`n"',
    '  $bytes = [System.Text.Encoding]::UTF8.GetBytes($norm + "`r`n`r`n")',
    '  $port.Write($bytes, 0, $bytes.Length)',
    '  $port.Write(([string][char]4))',
    '  $out = R-Wait ' + psq('>>> ') + ' $ms',
    '  return $out',
    '}',
    'try {',
    '  R-Read 150',
    '  $port.Write(([string][char]3))',
    '  R-Read 350',
    '  $p = R-Wait ' + psq('>>> ') + ' 6000',
    '  if (-not $p.Contains(' + psq('>>> ') + ')) {',
    '    $port.Write(([string][char]3))',
    '    $p2 = R-Wait ' + psq('>>> ') + ' 15000',
    '    if (-not $p2.Contains(' + psq('>>> ') + ')) {',
    '      $tail = $p + $p2',
    '      if ($tail.Length -gt 4000) { $tail = $tail.Substring($tail.Length - 4000) }',
    '      throw (' + psq('CanMV handshake failed. Board output so far: ') + ' + $tail)',
    '    }',
    '  }',
    '  R-Read 150'
  ].concat(opLines).concat([
    '} finally {',
    '  try { R-Read 100 } catch {}',
    '  try { $port.Close() } catch {}',
    '  try { $port.Dispose() } catch {}',
    '}'
  ]).join('\n')
}

const RESET_OPS = [
  '$port.Write(([string][char]4))',
  "$boot = R-Wait '>>> ' 20000",
  'R-Read 150',
  "Write-Output ('__OUT__' + [Convert]::ToBase64String([System.Text.Encoding]::UTF8.GetBytes($boot)))"
]

const INFO_CODE = [
  'import sys, os, gc',
  'print("__CANMV_INFO__")',
  'print("python:", sys.version)',
  'print("implementation:", sys.implementation)',
  'print("uname:", os.uname())',
  'try:',
  '    import machine',
  '    print("freq:", machine.freq())',
  'except Exception as _e:',
  '    print("freq: unavailable", _e)',
  'print("mem_free:", gc.mem_free())',
  'try:',
  '    import ubinascii',
  '    print("ubinascii: ok")',
  'except Exception:',
  '    pass'
].join('\n')

function uploadHelper(path) {
  return [
    'try:',
    '    import ubinascii as b64',
    'except ImportError:',
    '    import binascii as b64',
    'def _w(d):',
    '    f.write(b64.a2b_base64(d))',
    'f = open(' + pyq(path) + ', "wb")'
  ].join('\n')
}

function fsCode(op, path) {
  if (op === 'ls') {
    return [
      'import os',
      'try:',
      '    for _e in sorted(os.listdir(' + pyq(path) + ')):',
      '        print("__CANMV_LS__", _e)',
      'except Exception as _ex:',
      '    print("__CANMV_ERR__", repr(_ex))'
    ].join('\n')
  }
  if (op === 'cat') {
    return [
      'import sys',
      'try:',
      '    f = open(' + pyq(path) + ', "rb")',
      '    try:',
      '        while True:',
      '            _c = f.read(64)',
      '            if not _c:',
      '                break',
      '            sys.stdout.write(_c)',
      '    finally:',
      '        f.close()',
      'except Exception as _ex:',
      '    print("__CANMV_ERR__", repr(_ex))',
      'print("")',
      'print("__CANMV_END__")'
    ].join('\n')
  }
  if (op === 'rm') {
    return [
      'import os',
      'try:',
      '    os.remove(' + pyq(path) + ')',
      'except Exception as _ex:',
      '    print("__CANMV_ERR__", repr(_ex))',
      'print("__CANMV_END__")'
    ].join('\n')
  }
  return [
    'import os',
    'try:',
    '    os.mkdir(' + pyq(path) + ')',
    'except Exception as _ex:',
    '    print("__CANMV_ERR__", repr(_ex))',
    'print("__CANMV_END__")'
  ].join('\n')
}

function parseOut(stdout) {
  const outs = []
  let m
  const re = /__OUT__([A-Za-z0-9+/]+={0,2})/g
  while ((m = re.exec(stdout)) !== null) {
    try { outs.push(atob(m[1])) } catch (e) { outs.push(m[1]) }
  }
  return outs
}

function shellError(res) {
  if (res.timedOut) return 'timed out after ' + res.timeoutMs + 'ms'
  if (res.aborted) return 'aborted'
  if (res.sandbox !== undefined && res.sandbox.denied) return 'the sandbox denied this command under ' + res.sandbox.mode + ' mode'
  if (res.exitCode !== 0 && res.exitCode !== null) {
    const err = (res.stderr !== undefined && res.stderr.text !== undefined ? res.stderr.text : '').trim()
    return 'pwsh exited with code ' + res.exitCode + (err.length > 0 ? ': ' + err.slice(0, 2000) : '')
  }
  return null
}

function baudOf(value) {
  const n = Number(value)
  return Number.isFinite(n) && n >= 1200 && n <= 12000000 ? Math.floor(n) : DEFAULT_BAUD
}

return {
  inject: ['shell'],
  apply(ctx) {
    const shell = ctx.shell
    const sandboxPolicy = ctx.get('sandboxPolicy')
    const fs = ctx.get('fs')
    let cachedPort = null
    let cachedCanmv = false

    // ---------------- USBDBG 活动会话状态（脚本运行 + 预览） ----------------
    const RT = { dir: 'C:\\Embedded\\K230\\canmv-plugin\\runtime' }
    const RT_PATH = {
      cmd: RT.dir + '\\cmd.json',
      out: RT.dir + '\\output.log',
      status: RT.dir + '\\status.json',
      meta: RT.dir + '\\frame-meta.json',
      jpg: RT.dir + '\\latest.jpg',
      pid: RT.dir + '\\session-pid.json',
      writediag: RT.dir + '\\writediag.json',
      rundiag: RT.dir + '\\runstart-diag.json',
      sdiag: RT.dir + '\\session-diag.json',
    }
    // v12.12：用户要求会话不要定时关闭——SESSION_TIMEOUT_MS 语义改为"不限时"（0），
    // 面板显示"不限时"；runPs 的实际安全阀改为一整天（防进程彻底失控，正常不会触发）。
    const SESSION_TIMEOUT_MS = 0
    const SESSION_SHELL_TIMEOUT_MS = 24 * 3600 * 1000
    const session = { active: false, port: null, baud: null, outOffset: 0, startedAt: 0, endedAt: 0 }
    let sessionSeq = 0
    let sessionScriptPath = null
    // v12.18：采纳会话（proc=null）的 pidAlive 轮询节流时间戳
    let lastAdoptedPidCheck = 0

    // 面板 RPC 是无会话调用：resolve({}) 会回退到部署默认工作区根（可能覆盖系统
    // temp，导致 ACL 运行器拒绝启动）。这里优先取工作区包含 runtime 目录（RT.dir）
    // 的活会话，让 workspace-write 的边界 = 本工程工作区（与工具调用路径一致）。
    function resolvePanelPolicy() {
      if (sandboxPolicy === undefined) return undefined
      const rtLower = RT.dir.toLowerCase().replace(/[\\/]+$/, '')
      const matchCwd = (cwd) => {
        if (typeof cwd !== 'string' || cwd.length === 0) return false
        const c = cwd.toLowerCase().replace(/[\\/]+$/, '')
        return c === rtLower || rtLower.startsWith(c + '\\') || c.startsWith(rtLower + '\\')
      }
      try {
        const sessions = ctx.get('sessions')
        if (sessions !== undefined) {
          const live = sessions.list()
          let fallback = null
          for (let i = 0; i < live.length; i++) {
            const s = live[i]
            const cwd = s !== undefined && s.header !== undefined ? s.header.cwd : undefined
            if (typeof cwd === 'string' && cwd.length > 0) {
              if (fallback === null) fallback = s
              if (matchCwd(cwd)) return sandboxPolicy.resolve({ session: s })
            }
          }
          if (fallback !== null) return sandboxPolicy.resolve({ session: fallback })
        }
      } catch (e) {}
      try {
        const agents = ctx.get('agents')
        if (agents !== undefined) {
          const init = agents.currentInitiator()
          if (init !== undefined && init.session !== undefined) {
            return sandboxPolicy.resolve({ session: init.session })
          }
        }
      } catch (e) {}
      return sandboxPolicy.resolve({})
    }

    async function runPs(command, timeoutMs, exec) {
      const request = {
        command: command,
        timeoutMs: timeoutMs
      }
      if (exec !== undefined && exec.signal !== undefined) request.signal = exec.signal
      if (sandboxPolicy !== undefined) {
        const policy = exec !== undefined && exec.agent !== undefined
          ? sandboxPolicy.resolve({ session: exec.agent.session })
          : resolvePanelPolicy()
        if (policy !== undefined) request.sandboxPolicy = policy
      }
      return await shell.run(shell.resolve(request))
    }

    // v12.16：后台进程启动（无超时——shell.run 的 timeoutMs 会被部署默认
    // maxTimeoutMs=10 分钟钳制，会话类长任务必须走 start）。
    function startPs(command, exec) {
      const request = { command: command }
      if (sandboxPolicy !== undefined) {
        const policy = exec !== undefined && exec.agent !== undefined
          ? sandboxPolicy.resolve({ session: exec.agent.session })
          : resolvePanelPolicy()
        if (policy !== undefined) request.sandboxPolicy = policy
      }
      return shell.start(shell.resolve(request))
    }

    async function listPorts(exec) {
      const res = await runPs(PORTS_SCRIPT, 25000, exec)
      const err = shellError(res)
      if (err !== null) throw new Error('port enumeration failed: ' + err)
      const outs = parseOut(res.stdout !== undefined ? res.stdout.text : '')
      let arr = []
      try { arr = JSON.parse(outs[0] || '[]') } catch (e) {}
      if (!Array.isArray(arr)) arr = (arr !== null && typeof arr === 'object') ? [arr] : []
      const seen = {}
      const rows = []
      for (let i = 0; i < arr.length; i++) {
        const port = String(arr[i].port || '')
        if (port.length === 0 || seen[port]) continue
        seen[port] = true
        rows.push({ port: port, desc: String(arr[i].desc || ''), deviceid: String(arr[i].deviceid || '') })
      }
      return rows
    }

    function hayOf(p) {
      return (p.desc + ' ' + p.deviceid).toLowerCase()
    }

    function isCanmv(p) {
      return /vid_1209[&+_]pid_abd1/.test(hayOf(p))
    }

    function isVirtual(p) {
      return /bthmodem/.test(hayOf(p))
    }

    function isUsbSerial(p) {
      return !isVirtual(p) && /usb|serial|uart|ch34|ch55|ch57|ch93|cdc|acm|k230|canmv|vid_1a86|vid_4348/.test(hayOf(p))
    }

    function isK230ish(p) {
      return !isVirtual(p) && /ch343|ch342|k230|canmv/.test(hayOf(p))
    }

    function numOf(p) {
      const m = /COM(\d+)$/i.exec(p.port)
      return m !== null ? parseInt(m[1], 10) : Infinity
    }

    async function ensurePort(portArg, exec) {
      if (portArg !== undefined && String(portArg).trim().length > 0) {
        cachedPort = String(portArg).trim()
        cachedCanmv = false
        return { port: cachedPort, canmv: false }
      }
      if (cachedPort !== null) return { port: cachedPort, canmv: cachedCanmv }
      const ports = await listPorts(exec)
      if (ports.length === 0) throw new Error('no serial ports found - connect the CanMV K230 board over its USB port and check the driver')
      const tier0 = ports.filter(isCanmv)
      const tier1 = ports.filter(isK230ish)
      const tier2 = ports.filter(isUsbSerial)
      if (ports.length === 1) {
        cachedPort = ports[0].port
        cachedCanmv = isCanmv(ports[0])
        return { port: cachedPort, canmv: cachedCanmv }
      }
      if (tier0.length === 1) {
        cachedPort = tier0[0].port
        cachedCanmv = true
        return { port: cachedPort, canmv: true }
      }
      if (tier1.length === 1) {
        cachedPort = tier1[0].port
        cachedCanmv = false
        return { port: cachedPort, canmv: false }
      }
      if (tier1.length > 1) {
        const desc0 = tier1[0].desc
        const sameChip = tier1.every(function (p) { return p.desc === desc0 })
        if (sameChip) {
          tier1.sort(function (a, b) { return numOf(a) - numOf(b) })
          cachedPort = tier1[0].port
          cachedCanmv = false
          return { port: cachedPort, canmv: false }
        }
      }
      if (tier2.length === 1) {
        cachedPort = tier2[0].port
        cachedCanmv = false
        return { port: cachedPort, canmv: false }
      }
      const lines = ports.map(function (p) {
        const tag = isCanmv(p) ? ' [CanMV K230 board]' : (isK230ish(p) ? ' [likely K230/CanMV]' : (isUsbSerial(p) ? ' [usb-serial]' : ''))
        return '  ' + p.port + ' | ' + p.desc + (p.deviceid.length > 0 ? ' | ' + p.deviceid : '') + tag
      }).join('\n')
      throw new Error('multiple serial ports detected - pass "port" explicitly:\n' + lines)
    }

    async function runBoard(portArg, baudArg, opLines, exec, baseTimeout) {
      const sel = await ensurePort(portArg, exec)
      const baud = baudArg !== undefined ? baudOf(baudArg) : (sel.canmv ? CANMV_BAUD : DEFAULT_BAUD)
      const res = await runPs(sessionScript(sel.port, baud, opLines), baseTimeout, exec)
      const err = shellError(res)
      if (err !== null) {
        if (/does not exist|access to the port|denied/i.test(err) && portArg === undefined) {
          cachedPort = null
          cachedCanmv = false
        }
        if (session.active) {
          throw new Error(err + '（悬浮面板正在运行脚本/预览，占用串口——请先在面板点「停止」再试）')
        }
        throw new Error(err)
      }
      return { port: sel.port, baud: baud, text: res.stdout !== undefined ? res.stdout.text : '' }
    }

    let chain = Promise.resolve()
    function lock(fn) {
      const p = chain.then(() => fn())
      chain = p.then(() => {}, () => {})
      return p
    }
    const lockExecute = (fn) => (args, exec) => lock(() => fn(args, exec))
    const renderText = function (args, value) { return [{ type: 'text', text: String(value) }] }
    const notConcurrent = function () { return false }

    function registerToolSafe(def) {
      try {
        ctx.effect(() => harness.registerTool(ctx, harness.defineTool(def)))
        return true
      } catch (e) {
        console.log('[canmv] 工具 "' + def.name + '" 已被此前的动态包注册（孤儿注册），本包跳过；其功能仍由既有注册提供。停止旧 Run 卡或重启 DSH 后本包将接管该工具。')
        return false
      }
    }

    registerToolSafe({
      name: 'canmv_ports',
      description: '列出这台 Windows 机器上可用的串口及其设备描述（注册表枚举，含 USB VID/PID），用于找到 CanMV K230 开发板对应的 COM 口。CanMV K230 的 USB VID:PID 为 1209:ABD1。无需参数。',
      parameters: {},
      output: { schema: { type: 'string' }, render: renderText },
      timeoutMs: 30000,
      isConcurrencySafe: notConcurrent,
      execute: lockExecute(async (args, exec) => {
        try {
          const ports = await listPorts(exec)
          if (ports.length === 0) return 'no serial ports found on this machine'
          const lines = ports.map(function (p) {
            const tag = isCanmv(p) ? ' [CanMV K230 board]' : (isK230ish(p) ? ' [likely K230/CanMV]' : (isUsbSerial(p) ? ' [usb-serial]' : ''))
            return p.port + ' | ' + p.desc + (p.deviceid.length > 0 ? ' | ' + p.deviceid : '') + tag
          })
          return 'found ' + ports.length + ' serial port(s):\n' + lines.join('\n')
        } catch (e) {
          return 'canmv_ports failed: ' + String(e && e.message ? e.message : e)
        }
      })
    })

    registerToolSafe({
      name: 'canmv_exec',
      description: '在 CanMV K230 开发板上执行一段 Python 代码并返回输出。连接方式与 CanMV IDE 一致（USB CDC + DTR 边沿激活），代码经 base64 单行包裹后通过 Ctrl-E 粘贴模式执行，支持 def/try/except/class 任意 Python 结构。单次代码上限约 8000 字符，更长代码请上传为 .py 文件再执行。port 省略时自动探测（优先 VID 1209:ABD1 板载 USB 串口）；baud 省略时 CanMV 板默认 12000000，其他串口默认 115200；timeout_ms 默认 15000。',
      parameters: {
        code: { type: 'string', required: true, description: '要在开发板上执行的 Python 代码（整段编译执行）。print() 输出会被捕获返回。' },
        port: { type: 'string', description: '串口名，如 COM3。省略时自动探测。' },
        baud: { type: 'number', description: '波特率；省略时 CanMV 板载 USB 串口用 12000000，其他默认 115200。' },
        timeout_ms: { type: 'number', description: '板上代码执行超时（毫秒），默认 15000。' }
      },
      output: { schema: { type: 'string' }, render: renderText },
      timeoutMs: 180000,
      isConcurrencySafe: notConcurrent,
      execute: lockExecute(async (args, exec) => {
        try {
          const code = String(args.code || '').trim()
          if (code.length === 0) return 'canmv_exec failed: code must not be empty'
          if (code.length > MAX_EXEC) return 'canmv_exec failed: code too long (' + code.length + ' chars, max ' + MAX_EXEC + '). Upload it as a .py file with canmv_upload and run it from the board instead.'
          const t = Number.isFinite(Number(args.timeout_ms)) ? Math.floor(Number(args.timeout_ms)) : 15000
          const run = await runBoard(args.port, args.baud, opPaste(code, Math.max(3000, t)), exec, 30000 + Math.max(3000, t))
          const outs = parseOut(run.text)
          const parsed = parsePaste(outs[0] || '')
          const out = parsed.text
          const status = !parsed.complete ? 'incomplete (board did not finish in time)'
            : (/Traceback|NameError|SyntaxError|OSError|ValueError|TypeError|KeyError|MemoryError|RuntimeError/.test(out) ? 'error' : 'ok')
          return 'board: ' + run.port + ' @ ' + run.baud + '\nstatus: ' + status + '\n--- output ---\n' + out
        } catch (e) {
          return 'canmv_exec failed: ' + String(e && e.message ? e.message : e)
        }
      })
    })

    registerToolSafe({
      name: 'canmv_upload',
      description: '将本地文件上传到 K230 开发板文件系统（支持文本和二进制，如 .py / .kmodel），通过 base64 分块 + 粘贴模式写入（多次短会话，板载命名空间跨会话保持）。board_path 为板上路径（如 /sdcard/main.py 或 main.py），父目录需已存在（可用 canmv_fs mkdir 创建）。',
      parameters: {
        local_path: { type: 'string', required: true, description: '本地文件路径；相对路径基于会话工作目录。' },
        board_path: { type: 'string', required: true, description: '板上目标路径，如 /sdcard/main.py（使用正斜杠）。' },
        port: { type: 'string', description: '串口名，如 COM3。省略时自动探测。' },
        baud: { type: 'number', description: '波特率；省略时 CanMV 板载 USB 串口用 12000000，其他默认 115200。' }
      },
      output: { schema: { type: 'string' }, render: renderText },
      timeoutMs: 600000,
      isConcurrencySafe: notConcurrent,
      execute: lockExecute(async (args, exec) => {
        try {
          const boardPath = normBoardPath(args.board_path)
          if (fs === undefined) return 'canmv_upload failed: filesystem service unavailable in this composition'
          const cwd = (exec !== undefined && exec.agent !== undefined && exec.agent.session !== undefined && exec.agent.session.header !== undefined) ? exec.agent.session.header.cwd : undefined
          const target = await fs.resolve(String(args.local_path), cwd !== undefined ? { cwd: cwd, signal: exec.signal } : { signal: exec.signal })
          const bytes = await fs.readBytes(target, exec.signal, MAX_UPLOAD)
          const b64 = bytesToB64(bytes)
          const chunks = []
          for (let i = 0; i < b64.length; i += B64_CHUNK) chunks.push(b64.slice(i, i + B64_CHUNK))
          const sel = await ensurePort(args.port, exec)
          const baud = args.baud !== undefined ? baudOf(args.baud) : (sel.canmv ? CANMV_BAUD : DEFAULT_BAUD)
          const batches = []
          for (let i = 0; i < chunks.length; i += BATCH) batches.push(chunks.slice(i, i + BATCH))
          let allParts = []
          // call 1: helper + first batch
          let ops = []
          ops.push.apply(ops, opPaste(uploadHelper(boardPath), 8000))
          if (batches.length > 0) {
            for (let i = 0; i < batches[0].length; i++) {
              ops.push.apply(ops, opChunk('_w(' + psq(batches[0][i]) + ')', 12000))
            }
          }
          let res = await runPs(sessionScript(sel.port, baud, ops), 60000, exec)
          let err = shellError(res)
          if (err !== null) return 'canmv_upload failed: ' + err
          allParts = allParts.concat(parseOut(res.stdout !== undefined ? res.stdout.text : ''))
          // middle batches
          for (let b = 1; b < batches.length; b++) {
            let bops = []
            for (let i = 0; i < batches[b].length; i++) {
              bops.push.apply(bops, opChunk('_w(' + psq(batches[b][i]) + ')', 12000))
            }
            res = await runPs(sessionScript(sel.port, baud, bops), 60000, exec)
            err = shellError(res)
            if (err !== null) return 'canmv_upload failed: ' + err
            allParts = allParts.concat(parseOut(res.stdout !== undefined ? res.stdout.text : ''))
          }
          // final call: close + confirm
          res = await runPs(sessionScript(sel.port, baud, opPaste('f.close()\nprint("__CANMV_WROTE__", ' + bytes.length + ')', 8000)), 60000, exec)
          err = shellError(res)
          if (err !== null) return 'canmv_upload failed: ' + err
          allParts = allParts.concat(parseOut(res.stdout !== undefined ? res.stdout.text : ''))
          const parts = allParts.map(function (o) { return parsePaste(o).text })
          const last = parts.length > 0 ? parts[parts.length - 1] : ''
          const wrote = last.indexOf('__CANMV_WROTE__') >= 0
          let firstErr = null
          for (let i = 0; i < parts.length; i++) {
            if (/Traceback|Error/.test(parts[i])) { firstErr = parts[i]; break }
          }
          if (firstErr !== null) return 'canmv_upload failed on the board:\n' + firstErr.slice(0, 4000)
          if (!wrote) return 'canmv_upload incomplete: the board did not confirm the write. Last output:\n' + last.slice(0, 2000)
          return 'uploaded ' + bytes.length + ' bytes to ' + boardPath + ' on ' + sel.port + ' - board confirmed the write'
        } catch (e) {
          return 'canmv_upload failed: ' + String(e && e.message ? e.message : e)
        }
      })
    })

    registerToolSafe({
      name: 'canmv_fs',
      description: 'K230 开发板文件系统操作：ls 列目录 / cat 读文本文件 / rm 删除 / mkdir 建目录。path 为板上路径（正斜杠），如 /sdcard。',
      parameters: {
        op: { type: 'string', required: true, enum: ['ls', 'cat', 'rm', 'mkdir'], description: '操作类型。' },
        path: { type: 'string', description: '板上路径；ls 的目录（默认 /），cat/rm 的文件，mkdir 的目录。' },
        port: { type: 'string', description: '串口名，如 COM3。省略时自动探测。' },
        baud: { type: 'number', description: '波特率；省略时 CanMV 板载 USB 串口用 12000000，其他默认 115200。' }
      },
      output: { schema: { type: 'string' }, render: renderText },
      timeoutMs: 60000,
      isConcurrencySafe: notConcurrent,
      execute: lockExecute(async (args, exec) => {
        try {
          const op = String(args.op || 'ls')
          if (['ls', 'cat', 'rm', 'mkdir'].indexOf(op) < 0) return 'canmv_fs failed: unknown op "' + op + '"'
          let path = '/'
          if (args.path !== undefined) path = normBoardPath(args.path)
          else if (op !== 'ls') return 'canmv_fs failed: op "' + op + '" requires a path'
          const run = await runBoard(args.port, args.baud, opPaste(fsCode(op, path), 10000), exec, 45000)
          const outs = parseOut(run.text)
          const parsed = parsePaste(outs[0] || '')
          const out = parsed.text
          if (!parsed.complete) return 'canmv_fs incomplete:\n' + out.slice(0, 2000)
          if (op === 'ls') {
            const entries = []
            const re = /^__CANMV_LS__ (.*)$/gm
            let m
            while ((m = re.exec(out)) !== null) entries.push(m[1])
            const er = /__CANMV_ERR__ (.*)/.exec(out)
            if (er !== null) return 'canmv_fs ls failed on the board: ' + er[1]
            return 'directory ' + path + ' on ' + run.port + ' (' + entries.length + ' entries):\n' + entries.join('\n')
          }
          if (op === 'cat') {
            const er = /__CANMV_ERR__ (.*)/.exec(out)
            if (er !== null) return 'canmv_fs cat failed on the board: ' + er[1]
            const idx = out.lastIndexOf('__CANMV_END__')
            const content = idx >= 0 ? out.slice(0, idx).replace(/\r?\n$/, '') : out
            return '--- ' + path + ' on ' + run.port + ' ---\n' + content
          }
          const er2 = /__CANMV_ERR__ (.*)/.exec(out)
          if (er2 !== null) return 'canmv_fs ' + op + ' failed on the board: ' + er2[1]
          return 'canmv_fs ' + op + ' ' + path + ' on ' + run.port + ': ok'
        } catch (e) {
          return 'canmv_fs failed: ' + String(e && e.message ? e.message : e)
        }
      })
    })

    registerToolSafe({
      name: 'canmv_reset',
      description: '软复位 CanMV K230 开发板（Ctrl-D soft reboot）并捕获启动输出，包含固件版本信息。使用与 IDE 相同的 USB 连接方式（DTR 边沿激活）。',
      parameters: {
        port: { type: 'string', description: '串口名，如 COM3。省略时自动探测。' },
        baud: { type: 'number', description: '波特率；省略时 CanMV 板载 USB 串口用 12000000，其他默认 115200。' }
      },
      output: { schema: { type: 'string' }, render: renderText },
      timeoutMs: 60000,
      isConcurrencySafe: notConcurrent,
      execute: lockExecute(async (args, exec) => {
        try {
          const run = await runBoard(args.port, args.baud, RESET_OPS, exec, 50000)
          const outs = parseOut(run.text)
          const out = (outs[0] || '').replace(/\u0004+$/, '')
          return 'soft reset issued on ' + run.port + ' @ ' + run.baud + '\n--- boot output ---\n' + out
        } catch (e) {
          return 'canmv_reset failed: ' + String(e && e.message ? e.message : e)
        }
      })
    })

    registerToolSafe({
      name: 'canmv_info',
      description: '查询 CanMV K230 开发板信息：Python/MicroPython 版本、os.uname、可用内存等。',
      parameters: {
        port: { type: 'string', description: '串口名，如 COM3。省略时自动探测。' },
        baud: { type: 'number', description: '波特率；省略时 CanMV 板载 USB 串口用 12000000，其他默认 115200。' }
      },
      output: { schema: { type: 'string' }, render: renderText },
      timeoutMs: 60000,
      isConcurrencySafe: notConcurrent,
      execute: lockExecute(async (args, exec) => {
        try {
          const run = await runBoard(args.port, args.baud, opPaste(INFO_CODE, 8000), exec, 45000)
          const outs = parseOut(run.text)
          const parsed = parsePaste(outs[0] || '')
          return 'board: ' + run.port + ' @ ' + run.baud + '\n' + (parsed.complete ? parsed.text : 'incomplete output:\n' + parsed.text)
        } catch (e) {
          return 'canmv_info failed: ' + String(e && e.message ? e.message : e)
        }
      })
    })

    registerToolSafe({
      name: 'canmv_runfile',
      description: '把 code 文件夹里的一个 .py 文件（如 绿植检测_0.11.0.py）通过 USBDBG 活动会话交付到 K230 运行（soft reset → SCRIPT_EXEC → 输出流落盘 runtime/output.log、状态落盘 runtime/status.json）。v12.9 交付带字节数自校验（不匹配重试后拒绝交付）。返回会话是否启动；运行输出请随后用文件读取工具读 C:\\Embedded\\K230\\canmv-plugin\\runtime\\output.log 与 status.json（停止：把 {"cmd":"stop"} 写入 runtime/cmd.json）。',
      parameters: {
        name: { type: 'string', required: true, description: 'code 文件夹下的 .py 文件名（仅文件名，如 绿植检测_0.11.0.py）' },
        port: { type: 'string', description: '串口名，如 COM5。省略时自动探测。' },
        baud: { type: 'number', description: '波特率；省略时 CanMV 板默认 12000000。' }
      },
      output: { schema: { type: 'string' }, render: renderText },
      timeoutMs: 90000,
      isConcurrencySafe: notConcurrent,
      // v12.10 死锁修复：不得用 lockExecute 包装——startScriptSession 内部
      // 已调用 lock()，外层再包一层会造成链式锁互相等待（工具调用永远挂起，
      // 曾两次卡死 DSH 需重启）。这里直接 async 执行，由内部锁串行化。
      execute: async (args, exec) => {
        try {
          const name = String((args && args.name) || '').trim()
          if (!name || /[\\/]/.test(name) || !name.toLowerCase().endsWith('.py')) return 'canmv_runfile failed: 请提供 code 文件夹下的 .py 文件名（仅文件名）'
          const target = await fs.resolve('C:\\Embedded\\K230\\code\\' + name)
          const text = await fs.readText(target)
          const res = await startScriptSession(text, args && args.port, args && args.baud)
          if (!res.ok) return 'canmv_runfile failed: ' + (res.error || 'unknown')
          return 'canmv_runfile started on ' + res.port + ' @ ' + res.baud + '（' + name + '，' + text.length + ' 字符）。运行输出见 runtime/output.log，状态见 runtime/status.json；停止：把 {"cmd":"stop"} 写入 runtime/cmd.json'
        } catch (e) {
          return 'canmv_runfile failed: ' + String(e && e.message ? e.message : e)
        }
      }
    })

    // ---------------- v12.14：模型直驱工具（帧/预览/会话/停止） ----------------
    // 全部直接 async 执行 + 内部 lock 串行化（不得套 lockExecute，见 v12.10）。
    registerToolSafe({
      name: 'canmv_frame',
      description: '获取当前预览帧（最新一帧 JPEG）：返回帧号、分辨率、字节数、时间戳与本地文件路径 C:\\Embedded\\K230\\canmv-plugin\\runtime\\latest.jpg——用 read_image 工具读取该路径即可直接查看画面。前提：脚本会话正在运行且预览已开启（未开启时先用 canmv_preview 开启）。无需参数。',
      parameters: {},
      output: { schema: { type: 'string' }, render: renderText },
      timeoutMs: 30000,
      isConcurrencySafe: notConcurrent,
      execute: async (args, exec) => {
        try {
          const r = await frameFromSession()
          if (!r.ok) return 'canmv_frame failed: ' + r.error
          if (!r.available) return 'canmv_frame: 当前没有可用帧——' + r.reason
          return '最新预览帧: #' + r.frameId + ' ' + r.w + 'x' + r.h + ' ' + r.bytes + ' 字节 @ ' + r.at +
            '\n本地路径: ' + r.path + '\n（用 read_image 工具读取该路径即可看到画面）'
        } catch (e) {
          return 'canmv_frame failed: ' + String(e && e.message ? e.message : e)
        }
      }
    })

    registerToolSafe({
      name: 'canmv_preview',
      description: '开启或关闭预览抓帧（on=true 开启，on=false 关闭）。开启后会话 PS 会持续把最新帧写入 runtime\\latest.jpg + frame-meta.json，随后可用 canmv_frame 获取。需先运行脚本（canmv_runfile 或面板「▶ 运行脚本」）。',
      parameters: {
        on: { type: 'boolean', required: true, description: 'true=开启预览抓帧，false=关闭预览抓帧' }
      },
      output: { schema: { type: 'string' }, render: renderText },
      timeoutMs: 30000,
      isConcurrencySafe: notConcurrent,
      execute: async (args, exec) => {
        try {
          const on = !!(args && args.on)
          const r = await setPreviewOn(on)
          if (!r.ok) return 'canmv_preview failed: ' + (r.error || '未知错误')
          return on ? '预览抓帧已开启——板子出帧后用 canmv_frame 获取最新帧' : '预览抓帧已关闭'
        } catch (e) {
          return 'canmv_preview failed: ' + String(e && e.message ? e.message : e)
        }
      }
    })

    registerToolSafe({
      name: 'canmv_session',
      description: '查询当前脚本会话状态：会话是否运行、端口、脚本运行标志、已抓帧数、预览开关、结束标记、交付错误，以及输出日志尾部（最多 3000 字符）。无需参数。',
      parameters: {},
      output: { schema: { type: 'string' }, render: renderText },
      timeoutMs: 30000,
      isConcurrencySafe: notConcurrent,
      execute: async (args, exec) => {
        try {
          const r = await sessionStatusForTool()
          if (!r.ok) return 'canmv_session failed: ' + r.error
          return r.text
        } catch (e) {
          return 'canmv_session failed: ' + String(e && e.message ? e.message : e)
        }
      }
    })

    registerToolSafe({
      name: 'canmv_stop',
      description: '停止当前运行的脚本会话（与面板「停止」按钮等效）：向会话写 stop 指令，板子软停脚本并结束串口会话。无需参数。',
      parameters: {},
      output: { schema: { type: 'string' }, render: renderText },
      timeoutMs: 30000,
      isConcurrencySafe: notConcurrent,
      execute: async (args, exec) => {
        try {
          const r = await stopScriptSession()
          if (!r.ok) return 'canmv_stop failed: ' + (r.error || '未知错误')
          return r.stopped ? '已发送停止指令，脚本会话正在停止' : '当前没有运行中的会话（无需停止）'
        } catch (e) {
          return 'canmv_stop failed: ' + String(e && e.message ? e.message : e)
        }
      }
    })

    // ---------------- USBDBG 活动会话（脚本运行 + 预览），官方协议实现 ----------------
    // 单一后台 PS 进程持串口：soft reset → SCRIPT_EXEC → 循环（TX 输出流 + 脚本状态 + FB 抓帧），
    // 通过 runtime 目录文件与 Host/面板通信（cmd 标记文件 / output.log / status.json / latest.jpg）。
    function sessionUsbdbgScript(port, baud, scriptPath, expectedBytes) {
      return [
        "$ErrorActionPreference='Stop'",
        '$dir = ' + psq(RT.dir),
        '$scriptPath = ' + psq(scriptPath),
        'function Send-Cmd([int]$cmd,[byte[]]$payload,[uint32]$field){',
        '  $hdr = New-Object byte[] (6 + $payload.Length)',
        '  $hdr[0] = 0x30; $hdr[1] = [byte]$cmd',
        '  $lenBytes = [BitConverter]::GetBytes([uint32]$field)',
        '  [Array]::Copy($lenBytes, 0, $hdr, 2, 4)',
        '  if ($payload.Length -gt 0) { [Array]::Copy($payload, 0, $hdr, 6, $payload.Length) }',
        '  $p.Write($hdr, 0, $hdr.Length)',
        '}',
        'function Read-N([int]$n,[int]$ms){',
        '  $deadline = [DateTime]::UtcNow.AddMilliseconds($ms)',
        '  $list = New-Object System.Collections.Generic.List[byte]',
        '  while ($list.Count -lt $n -and [DateTime]::UtcNow -lt $deadline) {',
        '    if ($p.BytesToRead -gt 0) {',
        '      $cnt = [Math]::Min($p.BytesToRead, $n - $list.Count)',
        '      $buf = New-Object byte[] $cnt',
        '      [void]$p.Read($buf, 0, $cnt)',
        '      $list.AddRange($buf)',
        '    } else { Start-Sleep -Milliseconds 5 }',
        '  }',
        '  return $list.ToArray()',
        '}',
        'function Sync-Stream([int]$ms){',
        '  Send-Cmd 0x8D ([byte[]]@()) 0',
        '  $deadline = [DateTime]::UtcNow.AddMilliseconds($ms)',
        '  $ok = $false',
        '  $carry = [byte[]]@()',
        '  while (-not $ok -and [DateTime]::UtcNow -lt $deadline) {',
        '    $chunk = Read-N 4096 300',
        '    if ($chunk.Count -eq 0) { Start-Sleep -Milliseconds 5; continue }',
        '    $stream = $carry + $chunk',
        '    for ($i = 0; $i -le $stream.Count - 4; $i++) {',
        '      if ($stream[$i] -eq 0xAA -and $stream[$i+1] -eq 0xBB -and $stream[$i+2] -eq 0xEE -and $stream[$i+3] -eq 0xFF) { $ok = $true; break }',
        '    }',
        '    if ($stream.Count -ge 3) { $carry = @($stream[($stream.Count-3)], $stream[($stream.Count-2)], $stream[($stream.Count-1)]) }',
        '  }',
        '  return $ok',
        '}',
        'function Drain-Tx {',
        '  Send-Cmd 0x8E ([byte[]]@()) 4',
        '  $len4 = Read-N 4 1200',
        '  if ($len4.Count -eq 4) {',
        '    $tl = [int]([BitConverter]::ToUInt32($len4, 0))',
        '    if ($tl -gt 0 -and $tl -lt 262144) {',
        '      Send-Cmd 0x8F ([byte[]]@()) $tl',
        '      $tx = Read-N $tl 3000',
        '      if ($tx.Count -lt $tl) { [void](Sync-Stream 3000); return ' + psq('') + ' }',
        '      if ($tx.Count -gt 0) { return [System.Text.Encoding]::UTF8.GetString($tx) }',
        '    }',
        '    elseif ($tl -ge 262144) { [void](Sync-Stream 3000) }',
        '  }',
        '  return ' + psq('') ,
        '}',
        'try {',
        '  $p = [System.IO.Ports.SerialPort]::new(' + psq(port) + ',' + String(baud) + ')',
        '  $p.ReadTimeout = 200',
        '  $p.WriteTimeout = 15000',
        '  $p.Open()',
        '  [System.IO.File]::WriteAllText(($dir + ' + psq('\\session-pid.json') + '), (@{ pid = $PID; port = ' + psq(port) + '; baud = ' + String(baud) + '; at = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() } | ConvertTo-Json -Compress), [System.Text.Encoding]::UTF8)',
        '  $p.DtrEnable = $true;  Start-Sleep -Milliseconds 80',
        '  $p.DtrEnable = $false; Start-Sleep -Milliseconds 80',
        '  $p.DtrEnable = $true;  Start-Sleep -Milliseconds 250',
        '  [void](Sync-Stream 5000)',
        '  Send-Cmd 0x11 ([byte[]]@(0x04)) 1',
        '  Start-Sleep -Milliseconds 1500',
        '  [void](Sync-Stream 5000)',
        '  [void](Drain-Tx)',
        '  Remove-Item ($dir + ' + psq('\\cmd.json') + ') -Force -ErrorAction SilentlyContinue',
        '  Remove-Item ($dir + ' + psq('\\output.log') + ') -Force -ErrorAction SilentlyContinue',
        '  Remove-Item ($dir + ' + psq('\\status.json') + ') -Force -ErrorAction SilentlyContinue',
        '  Remove-Item ($dir + ' + psq('\\frame-meta.json') + ') -Force -ErrorAction SilentlyContinue',
        '  Remove-Item ($dir + ' + psq('\\latest.jpg') + ') -Force -ErrorAction SilentlyContinue',
        '  $logPath = $dir + ' + psq('\\output.log') ,
        '  $attempt = 0',
        '  $arr = $null',
        '  $rawLen = -1',
        '  $fileLen = -1',
        '  $mtime = ' + psq('') ,
        '  while ($attempt -lt 10 -and $null -eq $arr) {',
        '    $attempt = $attempt + 1',
        '    if (Test-Path -LiteralPath $scriptPath) {',
        '      $fi = Get-Item -LiteralPath $scriptPath',
        '      $fileLen = [int]$fi.Length',
        '      $mtime = [string]$fi.LastWriteTime',
        '      try { $raw = [System.IO.File]::ReadAllText($scriptPath) } catch { $raw = ' + psq('') + ' }',
        '      $rawLen = $raw.Length',
        '      if ($rawLen -gt 0) {',
        '        try {',
        '          $cand = New-Object System.Collections.Generic.List[byte]',
        '          $cand.AddRange([Convert]::FromBase64String($raw))',
        '          if ($cand.Count -eq ' + String(expectedBytes) + ') { $arr = $cand }',
        '          else { [System.IO.File]::AppendAllText($logPath, ("SCRIPT VERIFY attempt=" + $attempt + " rawLen=" + $rawLen + " fileLen=" + $fileLen + " bytes=" + $cand.Count + " expected=" + ' + String(expectedBytes) + ' + " mtime=" + $mtime + "`r`n"), [System.Text.Encoding]::UTF8) }',
        '        } catch { [System.IO.File]::AppendAllText($logPath, ("SCRIPT VERIFY decode-fail attempt=" + $attempt + " rawLen=" + $rawLen + " err=" + $_.Exception.Message + "`r`n"), [System.Text.Encoding]::UTF8) }',
        '      }',
        '    }',
        '    if ($null -eq $arr) { Start-Sleep -Milliseconds 800 }',
        '  }',
        '  if ($null -ne $arr) { Remove-Item -LiteralPath $scriptPath -Force -ErrorAction SilentlyContinue }',
        '  if ($null -eq $arr) {',
        '    [System.IO.File]::AppendAllText($logPath, ("SCRIPT DELIVERY REFUSED: 脚本文件校验 10 次未通过（预期 " + ' + String(expectedBytes) + ' + " 字节）。文件未交付到板子。`r`n"), [System.Text.Encoding]::UTF8)',
        '    $stR = @{ deliverError = ' + psq('script-file-verify-failed') + '; scriptRunning = $false; frames = 0; fb = $false; started = $false; done = $true; at = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() } | ConvertTo-Json -Compress',
        '    [System.IO.File]::WriteAllText(($dir + ' + psq('\\status.json') + '), $stR, [System.Text.Encoding]::UTF8)',
        '    return',
        '  }',
        '  $diagHead = [System.Text.Encoding]::UTF8.GetString($arr.ToArray(), 0, [Math]::Min(40, $arr.Count))',
        '  [System.IO.File]::AppendAllText($logPath, ("SESSION pid=" + $PID + " rawLen=" + $rawLen + " fileLen=" + $fileLen + " bytes=" + [string]$arr.Count + " head=" + $diagHead + "`r`n"), [System.Text.Encoding]::UTF8)',
        '  $arr.Add(10)',
        '  if ($arr.Count % 64 -eq 0) { $arr.Add(10) }',
        '  $data = $arr.ToArray()',
        '  $hdr = New-Object byte[] 6',
        '  $hdr[0] = 0x30; $hdr[1] = 0x05',
        '  $lenBytes = [BitConverter]::GetBytes([uint32]$data.Length)',
        '  [Array]::Copy($lenBytes, 0, $hdr, 2, 4)',
        '  $p.Write($hdr, 0, 6)',
        '  Start-Sleep -Milliseconds 500',
        '  $p.Write($data, 0, $data.Length)',
        '  Start-Sleep -Milliseconds 500',
        '  $fbOn = $false',
        '  $loop = $true',
        '  $running = $true',
        '  $started = $false',
        '  $zeros = 0',
        '  $frames = 0',
        '  $emptyProbes = 0',
        '  $errs = 0',
        '  $fbMisses = 0',
        '  $stall = 0',
        '  $frameStall = $false',
        '  $lastFrameAt = [DateTime]::UtcNow',
        '  $t0 = [DateTime]::UtcNow',
        '  while ($loop -and $running) {',
        '    try {',
        '    if (Test-Path ($dir + ' + psq('\\cmd.json') + ')) {',
        '      $cmdJson = $null',
        '      try { $cmdJson = Get-Content ($dir + ' + psq('\\cmd.json') + ') -Raw | ConvertFrom-Json } catch {}',
        '      Remove-Item ($dir + ' + psq('\\cmd.json') + ') -Force -ErrorAction SilentlyContinue',
        '      if ($cmdJson -ne $null -and $cmdJson.cmd -eq ' + psq('preview-on') + ') { Send-Cmd 0x0D ([byte[]]@(0x01,0x00)) 2; $fbOn = $true }',
        '      elseif ($cmdJson -ne $null -and $cmdJson.cmd -eq ' + psq('preview-off') + ') { Send-Cmd 0x0D ([byte[]]@(0x00,0x00)) 2; $fbOn = $false }',
        '      elseif ($cmdJson -ne $null -and $cmdJson.cmd -eq ' + psq('stop') + ') { $loop = $false }',
        '    }',
        '    $tx = Drain-Tx',
        '    if ($tx.Length -gt 0) { [System.IO.File]::AppendAllText(($dir + ' + psq('\\output.log') + '), $tx, [System.Text.Encoding]::UTF8) }',
        '    Send-Cmd 0x87 ([byte[]]@()) 4',
        '    $r4 = Read-N 4 1500',
        '    if ($r4.Count -eq 4) {',
        '      $cur = ([BitConverter]::ToUInt32($r4, 0) -ne 0)',
        '      if ($cur) { $started = $true; $zeros = 0; $running = $true }',
        '      elseif ($started) { $zeros++; if ($zeros -ge 6) { $running = $false } }',
        '      elseif (([DateTime]::UtcNow - $t0) -gt [TimeSpan]::FromSeconds(30)) { $running = $false }',
        '    }',
        '    if ($fbOn -and $running) {',
        '      Send-Cmd 0x81 ([byte[]]@()) 12',
        '      $fs = Read-N 12 2000',
        '      if ($fs.Count -eq 12) {',
        '        $jpegSize = [int]([BitConverter]::ToUInt32($fs, 8))',
        '        if ($jpegSize -gt 100 -and $jpegSize -lt 8000000) {',
        '          $emptyProbes = 0',
        '          Send-Cmd 0x82 ([byte[]]@()) $jpegSize',
        '          $jpeg = Read-N $jpegSize 8000',
        '          if ($jpeg.Count -eq $jpegSize -and $jpeg[0] -eq 255 -and $jpeg[1] -eq 216) {',
        '            [System.IO.File]::WriteAllBytes(($dir + ' + psq('\\latest.jpg') + '), $jpeg)',
        '            $w = [BitConverter]::ToUInt32($fs, 0)',
        '            $h = [BitConverter]::ToUInt32($fs, 4)',
        '            $frames++',
        '            $lastFrameAt = [DateTime]::UtcNow; $fbMisses = 0; $frameStall = $false',
        '            $meta = @{ frameId = $frames; w = $w; h = $h; bytes = $jpegSize; at = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() } | ConvertTo-Json -Compress',
        '            [System.IO.File]::WriteAllText(($dir + ' + psq('\\frame-meta.json') + '), $meta, [System.Text.Encoding]::UTF8)',
        '          } else { [void](Sync-Stream 3000) }',
        '        } else {',
        '          $emptyProbes++',
        '          if ($emptyProbes -ge 10) { $emptyProbes = 0; [System.IO.File]::AppendAllText($logPath, ("SESSION FRAME EMPTY - FB re-armed (frames=" + $frames + ")`r`n"), [System.Text.Encoding]::UTF8); Send-Cmd 0x0D ([byte[]]@(0x01,0x00)) 2 }',
        '        }',
        '      } else {',
        '        $fbMisses = $fbMisses + 1',
        '        if ($fbMisses -eq 1) { [System.IO.File]::AppendAllText($logPath, ("SESSION FRAME SIZE no-response (frames=" + $frames + ")`r`n"), [System.Text.Encoding]::UTF8) }',
        '        if ($fbMisses -ge 10) {',
        '          $fbMisses = 0',
        '          [System.IO.File]::AppendAllText($logPath, ("SESSION FRAME SIZE dead - FB re-armed (frames=" + $frames + ")`r`n"), [System.Text.Encoding]::UTF8)',
        '          Send-Cmd 0x0D ([byte[]]@(0x00,0x00)) 2',
        '          Start-Sleep -Milliseconds 300',
        '          Send-Cmd 0x0D ([byte[]]@(0x01,0x00)) 2',
        '        }',
        '      }',
        '    }',
        '    if ($fbOn -and $running) {',
        '      if (([DateTime]::UtcNow - $lastFrameAt) -gt [TimeSpan]::FromSeconds(60)) {',
        '        $frameStall = $true',
        '        $stall = $stall + 1',
        '        if ($stall -le 2 -or ($stall % 6) -eq 0) { [System.IO.File]::AppendAllText($logPath, ("SESSION FRAME STALL secs=" + [int]([DateTime]::UtcNow - $lastFrameAt).TotalSeconds + " n=" + $stall + " frames=" + $frames + "`r`n"), [System.Text.Encoding]::UTF8) }',
        '        Send-Cmd 0x0D ([byte[]]@(0x00,0x00)) 2',
        '        Start-Sleep -Milliseconds 300',
        '        Send-Cmd 0x0D ([byte[]]@(0x01,0x00)) 2',
        '        $lastFrameAt = [DateTime]::UtcNow',
        '      } else { $stall = 0 }',
        '    }',
        '    $st = @{ scriptRunning = $running; frames = $frames; fb = $fbOn; started = $started; loopErrors = $errs; frameStall = $frameStall; lastFrameAt = [DateTimeOffset]$lastFrameAt; at = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() } | ConvertTo-Json -Compress',
        '    [System.IO.File]::WriteAllText(($dir + ' + psq('\\status.json') + '), $st, [System.Text.Encoding]::UTF8)',
        '    $errs = 0',
        '    Start-Sleep -Milliseconds 150',
        '    } catch {',
        '      $errs = $errs + 1',
        '      $msg = $_.Exception.Message',
        '      if ($msg.Length -gt 300) { $msg = $msg.Substring(0, 300) }',
        '      [System.IO.File]::AppendAllText($logPath, ("SESSION LOOP ERROR n=" + $errs + " err=" + $msg + "`r`n"), [System.Text.Encoding]::UTF8)',
        '      if ($errs -ge 10) { $running = $false }',
        '      Start-Sleep -Milliseconds 500',
        '    }',
        '  }',
        '  try {',
        '    if ($fbOn) { Send-Cmd 0x0D ([byte[]]@(0x00,0x00)) 2 }',
        '    if ($running) { Send-Cmd 0x06 ([byte[]]@()) 0 }',
        '    Start-Sleep -Milliseconds 400',
        '    $tx2 = Drain-Tx',
        '    if ($tx2.Length -gt 0) { [System.IO.File]::AppendAllText(($dir + ' + psq('\\output.log') + '), $tx2, [System.Text.Encoding]::UTF8) }',
        '  } catch {',
        '    [System.IO.File]::AppendAllText($logPath, ("SESSION LOOP ERROR finalize: " + $_.Exception.Message + "`r`n"), [System.Text.Encoding]::UTF8)',
        '  }',
        '  $st2 = @{ scriptRunning = $false; frames = $frames; fb = $false; done = $true; started = $started; loopErrors = $errs; frameStall = $frameStall; lastFrameAt = [DateTimeOffset]$lastFrameAt; at = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() } | ConvertTo-Json -Compress',
        '  try { [System.IO.File]::WriteAllText(($dir + ' + psq('\\status.json') + '), $st2, [System.Text.Encoding]::UTF8) } catch {}',
        '} finally {',
        '  try { $p.Close() } catch {}',
        '}',
      ].join('\n')
    }

    async function readRuntimeText(path) {
      try {
        const target = await fs.resolve(path)
        return await fs.readText(target)
      } catch (e) {
        return null
      }
    }

    async function writeRuntimeText(path, text) {
      const target = await fs.resolve(path)
      // fs 写入带沙箱围栏：不传 policy 时 checkedTarget 回退到无会话的
      // sandboxPolicy.resolve()（部署默认工作区根，不含本会话工作区），
      // 导致 workspace-write 拒绝。这里显式传面板会话解析出的 policy。
      const policy = sandboxPolicy !== undefined ? resolvePanelPolicy() : undefined
      try {
        if (policy !== undefined) {
          await fs.writeText(target, String(text), undefined, undefined, policy)
        } else {
          await fs.writeText(target, String(text))
        }
        return
      } catch (e) {
        console.log('[canmv] fs.writeText 失败（' + String((e && e.message) || e) + '），改用 PowerShell 分块写入')
      }
      // 回退：经 PowerShell 分块写入（每块 ≤ 24KB，避开命令行长度上限；
      // base64 内容不含 ''@，here-string 安全）。shell 后端使用同样的
      // resolvePanelPolicy()，workspace-write 边界 = 会话工作区。
      const s = String(text)
      const CH = 24000
      const lines = [
        "$ErrorActionPreference = 'Stop'",
        '$p = ' + psq(path),
        '$dir = [System.IO.Path]::GetDirectoryName($p)',
        '$null = [System.IO.Directory]::CreateDirectory($dir)',
        'if (Test-Path -LiteralPath $p) { Remove-Item -LiteralPath $p -Force }'
      ]
      for (let i = 0; i < s.length; i += CH) {
        // UTF8Encoding($false) = 无 BOM，避免首块 BOM 破坏 FromBase64String
        lines.push('[System.IO.File]::AppendAllText($p, ' + psh(s.slice(i, i + CH)) + ', [System.Text.UTF8Encoding]::new($false))')
      }
      const res = await runPs(lines.join('\n'), 60000, undefined)
      const err = shellError(res)
      if (err !== null) throw new Error('runtime file write failed (PS fallback): ' + err)
    }

    function startScriptSession(code, portArg, baudArg) {
      return lock(async () => {
        if (session.active) return { ok: false, error: '会话已在运行（先点停止，再重新运行）' }
        // v12.9 僵尸清理：上次会话若崩溃，其 PS 进程可能仍持有 COM 口。
        // 会话启动时会把 $PID 写进 session-pid.json；这里检测残留并强杀。
        const pidTxt = await readRuntimeText(RT_PATH.pid)
        if (pidTxt !== null) {
          try {
            const pidInfo = JSON.parse(pidTxt)
            const zpid = parseInt(String(pidInfo.pid), 10)
            if (Number.isFinite(zpid) && zpid > 0) {
              const killCmd = [
                '$zp = Get-Process -Id ' + zpid + ' -ErrorAction SilentlyContinue',
                'if ($zp -ne $null -and ($zp.ProcessName -eq ' + psq('powershell') + ' -or $zp.ProcessName -eq ' + psq('pwsh') + ')) { Stop-Process -Id ' + zpid + ' -Force -ErrorAction SilentlyContinue; Start-Sleep -Milliseconds 700 }'
              ].join('\n')
              try { await runPs(killCmd, 20000, undefined) } catch (e) {}
              console.log('[canmv] 僵尸会话清理：pid=' + zpid)
            }
          } catch (e) {}
        }
        // v12.8 保险带：无论上游哪一环漏修，最终交付前再修一次（对干净文本恒等）
        code = repairMojibake(code)
        try { await writeRuntimeText(RT_PATH.sdiag, JSON.stringify({ stage: 'session', at: Date.now(), len: code.length, head: code.slice(0, 48) })) } catch (e) {}
        if (code.length > 524288) return { ok: false, error: '脚本过大（超过 512KB 上限）' }
        const sel = await ensurePort(portArg, undefined)
        // ensurePort 不返回 baud（板载 CanMV 用 12M），这里与工具路径一致地选择
        const baud = baudArg !== undefined ? baudOf(baudArg) : (sel.canmv ? CANMV_BAUD : DEFAULT_BAUD)
        // 脚本 base64 经文件传递，避免 shell 命令行长度上限（大脚本）。
        // v12.11：必须用纯字节级 utf8B64()——沙箱 btoa 是 UTF-8 感知实现，
        // btoa(unescape(encodeURIComponent(x))) 会把字节串再编码一遍（实测
        // 130528/97896，v12.5~v12.10 板子乱码的真凶），utf8B64 彻底绕开它。
        const b64 = utf8B64(code)
        const utf8Len = unescape(encodeURIComponent(code)).length
        // v12.9：唯一文件名，杜绝共享 script.b64 被并发写者换掉的竞争
        sessionSeq = sessionSeq + 1
        const scriptPath = RT.dir + '\\script-' + Date.now() + '-' + sessionSeq + '.b64'
        sessionScriptPath = scriptPath
        console.log('[canmv run.start] code.len=' + code.length + ' b64.len=' + b64.length + ' utf8.len=' + utf8Len + ' b64Bytes=' + b64ByteLen(b64) + ' script=' + scriptPath + ' code.head=' + JSON.stringify(code.slice(0, 40)))
        await writeRuntimeText(scriptPath, b64)
        // v12.9/v12.11：写回校验——读回文件确认长度/头部与写入一致，
        // 且 b64 承载的字节数必须恰等于 utf8Len（杜绝未来再出现双编码），
        // 否则拒绝启动会话。
        const readback = await readRuntimeText(scriptPath)
        const wd = {
          at: Date.now(), scriptPath: scriptPath, expectedLen: b64.length, expectedBytes: utf8Len, b64Bytes: b64ByteLen(b64),
          readbackLen: readback === null ? -1 : readback.length,
          readbackHead: readback === null ? '' : readback.slice(0, 48),
          ok: readback !== null && readback.length === b64.length && readback.slice(0, 48) === b64.slice(0, 48) && b64ByteLen(b64) === utf8Len,
        }
        try { await writeRuntimeText(RT_PATH.writediag, JSON.stringify(wd)) } catch (e) {}
        if (!wd.ok) {
          console.log('[canmv] 脚本文件写回校验失败：' + JSON.stringify(wd))
          return { ok: false, error: '脚本文件写回校验失败（读回长度 ' + wd.readbackLen + ' ≠ 写入 ' + wd.expectedLen + '）。请重试；若反复失败请把 runtime/writediag.json 发给助手。' }
        }
        const script = sessionUsbdbgScript(sel.port, baud, scriptPath, utf8Len)
        session.active = true
        session.port = sel.port
        session.baud = baud
        session.outOffset = 0
        session.startedAt = Date.now()
        session.endedAt = 0
        // v12.16：会话改用 shell.start 后台进程（run() 的 timeoutMs 会被部署默认
        // maxTimeoutMs=10 分钟钳制——耐久测试两次实测 ~10.5 分钟被杀的真凶；
        // 后台进程无超时，会话真正"不限时"）。
        let proc = null
        try {
          proc = await startPs(script, undefined)
        } catch (e) {
          session.active = false
          session.endedAt = Date.now()
          console.log('[canmv session] spawn failed: ' + String((e && e.message) || e))
          return { ok: false, error: '会话进程启动失败: ' + String((e && e.message) || e) }
        }
        session.proc = proc
        proc.done
          .then((res) => { console.log('[canmv session] exited exitCode=' + (res ? res.exitCode : '?') + ' timedOut=' + !!(res && res.timedOut)) })
          .catch((e) => { console.log('[canmv session] error: ' + String((e && e.message) || e)) })
          .finally(() => { session.active = false; session.endedAt = Date.now(); session.proc = null })
        return { ok: true, port: sel.port, baud: baud }
      })
    }

    function pollScriptSession() {
      return lock(async () => {
        // v12.18：采纳会话（proc=null）无法靠 proc.done 感知退出——节流 pidAlive
        // 轮询（每 5 秒一次），进程死亡后清除活动状态。
        if (session.active && session.proc === null) {
          if (Date.now() - lastAdoptedPidCheck > 5000) {
            lastAdoptedPidCheck = Date.now()
            try {
              const pidTxt = await readRuntimeText(RT_PATH.pid)
              let alive = false
              if (pidTxt !== null) {
                const pidInfo = JSON.parse(pidTxt)
                const pid = parseInt(String(pidInfo.pid), 10)
                if (Number.isFinite(pid) && pid > 0) alive = await pidAlive(pid)
              }
              if (!alive) {
                session.active = false
                session.endedAt = Date.now()
                console.log('[canmv] 采纳会话进程已退出，清除活动状态')
              }
            } catch (e) {}
          }
        }
        let st = null
        const stTxt = await readRuntimeText(RT_PATH.status)
        try { st = stTxt !== null ? JSON.parse(stTxt) : null } catch (e) { st = null }
        let out = ''
        try {
          const outTxt = await readRuntimeText(RT_PATH.out)
          if (outTxt !== null) {
            if (outTxt.length < session.outOffset) session.outOffset = 0
            out = outTxt.slice(session.outOffset)
            session.outOffset = outTxt.length
          }
        } catch (e) {}
        const active = session.active
        if (!active && st !== null && st.done === undefined) st = Object.assign({}, st, { done: true })
        return {
          ok: true,
          active: active,
          startedAt: session.startedAt,
          expiresInMs: active ? (SESSION_TIMEOUT_MS > 0 ? Math.max(0, SESSION_TIMEOUT_MS - (Date.now() - session.startedAt)) : -1) : 0,
          port: session.port,
          status: st || { scriptRunning: false, frames: 0, fb: false, done: !active },
          newOutput: out,
        }
      })
    }

    function setPreviewOn(on) {
      return lock(async () => {
        if (!session.active) return { ok: false, error: '请先运行脚本（预览需要脚本在运行中）' }
        await writeRuntimeText(RT_PATH.cmd, JSON.stringify({ cmd: on ? 'preview-on' : 'preview-off' }))
        return { ok: true }
      })
    }

    function stopScriptSession() {
      return lock(async () => {
        if (!session.active) return { ok: true, stopped: false }
        await writeRuntimeText(RT_PATH.cmd, JSON.stringify({ cmd: 'stop' }))
        return { ok: true, stopped: true }
      })
    }

    function previewFrame() {
      return lock(async () => {
        try {
          const metaTxt = await readRuntimeText(RT_PATH.meta)
          if (metaTxt === null) return { ok: true, available: false }
          const meta = JSON.parse(metaTxt)
          const target = await fs.resolve(RT_PATH.jpg)
          const bytes = await fs.readBytes(target, undefined, 8000000)
          return { ok: true, available: true, frameId: meta.frameId, w: meta.w, h: meta.h, bytes: meta.bytes, at: meta.at, b64: bytesToB64(bytes) }
        } catch (e) {
          return { ok: true, available: false }
        }
      })
    }

    // ---------------- v12.14：模型工具用的会话读取函数 ----------------
    function frameFromSession() {
      return lock(async () => {
        if (!session.active) return { ok: true, available: false, reason: '会话未运行——请先运行脚本（面板「▶ 运行脚本」或 canmv_runfile）' }
        try {
          const metaTxt = await readRuntimeText(RT_PATH.meta)
          if (metaTxt === null) return { ok: true, available: false, reason: '尚无帧元数据——预览可能未开启（用 canmv_preview 开启）或板子还没出帧' }
          const meta = JSON.parse(metaTxt)
          if (typeof meta.at === 'number' && meta.at < session.startedAt) return { ok: true, available: false, reason: '帧数据是上一个会话的旧帧——先用 canmv_preview 开启预览并等待首帧' }
          const target = await fs.resolve(RT_PATH.jpg)
          const bytes = await fs.readBytes(target, undefined, 8000000)
          if (bytes.length !== meta.bytes) return { ok: true, available: false, reason: '读到帧不完整（' + bytes.length + '/' + meta.bytes + ' 字节）——稍后重试' }
          return { ok: true, available: true, frameId: meta.frameId, w: meta.w, h: meta.h, bytes: meta.bytes, at: meta.at, path: RT_PATH.jpg }
        } catch (e) {
          return { ok: false, error: String((e && e.message) || e) }
        }
      })
    }

    function sessionStatusForTool() {
      return lock(async () => {
        try {
          const stTxt = await readRuntimeText(RT_PATH.status)
          let st = null
          try { st = stTxt !== null ? JSON.parse(stTxt) : null } catch (e) { st = null }
          let tail = ''
          const outTxt = await readRuntimeText(RT_PATH.out)
          if (outTxt !== null && outTxt.length > 0) tail = outTxt.slice(-3000)
          const lines = [
            '会话: ' + (session.active ? '运行中' : '未运行'),
            '端口: ' + (session.port || '-'),
            '脚本运行: ' + (st ? !!st.scriptRunning : false),
            '已抓帧数: ' + (st ? (st.frames || 0) : 0),
            '预览: ' + (st ? !!st.fb : false) + (st && st.started !== undefined ? '  started=' + !!st.started : ''),
            '循环错误: ' + (st ? (st.loopErrors || 0) : 0),
            '帧冻结: ' + (st ? !!st.frameStall : false) + (st && st.lastFrameAt ? '  最后帧=' + String(st.lastFrameAt) : ''),
            '结束标记: ' + (st ? !!st.done : false),
          ]
          if (st && st.deliverError) lines.push('交付错误: ' + st.deliverError)
          if (tail.length > 0) lines.push('--- 输出日志尾部（最多 3000 字符） ---\n' + tail)
          return { ok: true, text: lines.join('\n') }
        } catch (e) {
          return { ok: false, error: String((e && e.message) || e) }
        }
      })
    }

    // ---------------- v12.16：既有会话采纳 ----------------
    // 会话改后台进程后，插件更新/重载不会杀死会话 PS；新实例据此认领仍在运行
    // 的会话（pid 存活 + status 非 done 即采纳），避免"孤儿会话"（面板/工具
    // 与真实会话失联）。
    async function pidAlive(pid) {
      try {
        const res = await runPs('$p = Get-Process -Id ' + pid + ' -ErrorAction SilentlyContinue; if ($p) { Write-Output __ALIVE__1 } else { Write-Output __ALIVE__0 }', 15000, undefined)
        const out = res.stdout !== undefined ? res.stdout.text : ''
        return out.indexOf('__ALIVE__1') >= 0
      } catch (e) {
        return false
      }
    }

    function adoptExistingSession() {
      return lock(async () => {
        if (session.active) return
        try {
          const pidTxt = await readRuntimeText(RT_PATH.pid)
          if (pidTxt === null) return
          const pidInfo = JSON.parse(pidTxt)
          const pid = parseInt(String(pidInfo.pid), 10)
          if (!Number.isFinite(pid) || pid <= 0) return
          if (!(await pidAlive(pid))) return
          const stTxt = await readRuntimeText(RT_PATH.status)
          let st = null
          try { st = stTxt !== null ? JSON.parse(stTxt) : null } catch (e) { st = null }
          if (st === null || st.done === true || st.scriptRunning === false) return
          session.active = true
          session.port = String(pidInfo.port || '')
          const pidBaud = Number(pidInfo.baud)
          session.baud = Number.isFinite(pidBaud) && pidBaud >= 1200 ? Math.floor(pidBaud) : CANMV_BAUD
          session.outOffset = 0
          const outTxt = await readRuntimeText(RT_PATH.out)
          session.outOffset = outTxt !== null ? outTxt.length : 0
          session.startedAt = typeof pidInfo.at === 'number' ? pidInfo.at : Date.now()
          session.endedAt = 0
          console.log('[canmv] 采纳既有会话：pid=' + pid + ' port=' + session.port + ' frames=' + (st.frames || 0))
        } catch (e) {
          console.log('[canmv] 采纳既有会话失败：' + String((e && e.message) || e))
        }
      })
    }

    // ---------------- 悬浮面板私有 RPC（Client→Host） ----------------
    harness.handle('panel.ports', () => lock(async () => {
      try {
        const ports = await listPorts()
        const detected = ports.find(isCanmv) || null
        return { ok: true, ports: ports, detected: detected }
      } catch (e) {
        return { ok: false, error: String((e && e.message) || e) }
      }
    }))

    harness.handle('panel.info', (args) => lock(async () => {
      try {
        const run = await runBoard(args && args.port, args && args.baud, opPaste(INFO_CODE, 8000), undefined, 45000)
        const outs = parseOut(run.text)
        const parsed = parsePaste(outs[0] || '')
        return { ok: true, text: parsed.complete ? parsed.text : 'incomplete output:\n' + parsed.text, port: run.port, baud: run.baud }
      } catch (e) {
        return { ok: false, error: String((e && e.message) || e) }
      }
    }))

    harness.handle('panel.exec', (args) => lock(async () => {
      const code = codeFromArgs(args).trim()
      if (!code) return { ok: false, error: '代码为空' }
      if (code.length > MAX_EXEC) return { ok: false, error: '代码超过 ' + MAX_EXEC + ' 字符上限' }
      try {
        const run = await runBoard(args && args.port, args && args.baud, opPaste(code, 15000), undefined, 45000)
        const outs = parseOut(run.text)
        const parsed = parsePaste(outs[0] || '')
        return { ok: true, output: parsed.complete ? parsed.text : 'incomplete output:\n' + parsed.text, port: run.port, baud: run.baud }
      } catch (e) {
        return { ok: false, error: String((e && e.message) || e) }
      }
    }))

    harness.handle('panel.reset', (args) => lock(async () => {
      try {
        const run = await runBoard(args && args.port, args && args.baud, RESET_OPS, undefined, 50000)
        const outs = parseOut(run.text)
        const out = (outs[0] || '').replace(/\u0004+$/, '')
        return { ok: true, text: out, port: run.port }
      } catch (e) {
        return { ok: false, error: String((e && e.message) || e) }
      }
    }))

    harness.handle('panel.ping', (args) => {
      console.log('[canmv panel] ' + JSON.stringify({
        at: Date.now(),
        port: args && args.port,
        ok: !!(args && args.ok),
        status: args && args.status,
        error: args && args.error,
      }))
      return { ok: true }
    })

    harness.handle('panel.run.start', (args) => {
      const a = args || {}
      const diag = {
        at: Date.now(),
        keys: Object.keys(a),
        codeB64Len: typeof a.codeB64 === 'string' ? a.codeB64.length : -1,
        codeB64Head: typeof a.codeB64 === 'string' ? a.codeB64.slice(0, 48) : '',
        codeLen: typeof a.code === 'string' ? a.code.length : -1,
        codeHead: typeof a.code === 'string' ? a.code.slice(0, 48) : '',
        codeHeadKeyLen: typeof a.codeHead === 'string' ? a.codeHead.length : -1,
        codeHeadKey: typeof a.codeHead === 'string' ? a.codeHead.slice(0, 48) : '',
      }
      let atobOut = ''
      try { if (typeof a.codeB64 === 'string') atobOut = atob(a.codeB64) } catch (e) { atobOut = 'THROW: ' + String(e && e.message) }
      diag.atobLen = typeof atobOut === 'string' ? atobOut.length : -1
      diag.atobHead = typeof atobOut === 'string' ? atobOut.slice(0, 48) : ''
      const code = codeFromArgs(a)
      diag.finalLen = code.length
      diag.finalHead = code.slice(0, 48)
      try { diag.expectedBytes = unescape(encodeURIComponent(code)).length } catch (e) { diag.expectedBytes = -1 }
      try { writeRuntimeText(RT_PATH.rundiag, JSON.stringify(diag)).catch(() => {}) } catch (e) {}
      if (!code.trim()) return Promise.resolve({ ok: false, error: '代码为空' })
      return startScriptSession(code, a.port, a.baud)
    })

    harness.handle('panel.run.poll', () => pollScriptSession())

    harness.handle('panel.run.stop', () => stopScriptSession())

    // v12.12：断开连接——停止正在运行的会话（如有），并清除缓存的端口探测结果，
    // 让面板回到"未连接"状态（下次连接/运行时重新探测）。
    harness.handle('panel.disconnect', () => lock(async () => {
      const wasActive = session.active
      if (wasActive) {
        try { await writeRuntimeText(RT_PATH.cmd, JSON.stringify({ cmd: 'stop' })) } catch (e) {}
      }
      cachedPort = null
      cachedCanmv = false
      return { ok: true, stopped: wasActive }
    }))

    harness.handle('panel.preview.on', () => setPreviewOn(true))

    harness.handle('panel.preview.off', () => setPreviewOn(false))

    harness.handle('panel.preview.frame', () => previewFrame())

    // ---------------- 本地脚本文件（code 文件夹） ----------------
    const SCRIPTS_DIR = 'C:\\Embedded\\K230\\code'

    harness.handle('panel.files.list', () => lock(async () => {
      try {
        const target = await fs.resolve(SCRIPTS_DIR)
        const entries = await fs.listDir(target)
        const files = entries
          .filter(e => e !== undefined && e.name !== undefined && String(e.name).toLowerCase().endsWith('.py'))
          .map(e => ({ name: String(e.name) }))
        return { ok: true, dir: SCRIPTS_DIR, files: files }
      } catch (e) {
        return { ok: false, error: String((e && e.message) || e) }
      }
    }))

    harness.handle('panel.files.load', (args) => lock(async () => {
      const name = args && args.name ? String(args.name) : ''
      if (!name || /[\\/]/.test(name) || !name.toLowerCase().endsWith('.py')) return { ok: false, error: '无效文件名' }
      try {
        const target = await fs.resolve(SCRIPTS_DIR + '\\' + name)
        const text = await fs.readText(target)
        return { ok: true, name: name, code: text, codeB64: utf8B64(text) }
      } catch (e) {
        return { ok: false, error: String((e && e.message) || e) }
      }
    }))

    // v12.16：插件更新/重载后采纳仍在运行的后台会话（避免孤儿会话）
    try { adoptExistingSession() } catch (e) {}
  }
}

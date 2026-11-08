import { atom, read, update } from 'claude-code'
import type { Color, Register } from 'claude-code'
import type { Bucket, Stats } from '../types'

const PANE = 'ragnos-hud'
const SIDEBAR_W = 30
const INNER = SIDEBAR_W - 4
const H5 = 5 * 3600_000
const D7 = 7 * 24 * 3600_000
const MAX_READ = 4 * 1024 * 1024
const FRAME_MS = 250

// Colores del tema activo de Claude Code: el panel cambia con /theme.
const C = {
  frame: 'promptBorder',
  accent: 'claude',
  text: 'text',
  label: 'inactive',
  faint: 'subtle',
  pulse: 'suggestion',
  ok: 'success',
  warn: 'warning',
  bad: 'error',
} as const satisfies Record<string, Color>

// Sparkline: 5 h en tramos de 15 min, uno por columna.
const SPARK_LABEL = 'ritmo '
const SPARK_SLOTS = INNER - SPARK_LABEL.length
const SLOT_MS = H5 / SPARK_SLOTS
const BARS = '▁▂▃▄▅▆▇█'

// Carpeta de logs: respeta CLAUDE_CONFIG_DIR (como Claude Code) y si no, ~/.claude.
function projectsRoot(configDir: string, userProfile: string, home: string): string {
  const norm = (p: string) => p.trim().replace(/\\/g, '/').replace(/\/+$/, '')
  const cfg = norm(configDir)
  if (cfg) return `${cfg}/projects`
  return `${norm(userProfile) || norm(home)}/.claude/projects`
}

const empty = (): Bucket => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, requests: 0, usd: 0 })
const initial: Stats = {
  status: 'loading',
  scannedAt: 0,
  skipped: 0,
  h5: empty(),
  d7: empty(),
  session: empty(),
  limits: [],
  spark: [],
  lastAt: 0,
  ttlMs: 300_000,
  lastCtx: 0,
  sessionFound: false,
  hits: [],
  heat: [],
}

const stats = atom({ plugin: 'ragnos-hud', key: 'stats' } as const, initial, { shape: 'stats-6' })
const tick = atom({ plugin: 'ragnos-hud', key: 'tick' } as const, 0)

function add(b: Bucket, u: any) {
  b.input += u.input_tokens ?? 0
  b.output += u.output_tokens ?? 0
  b.cacheRead += u.cache_read_input_tokens ?? 0
  b.cacheWrite += u.cache_creation_input_tokens ?? 0
  b.requests += 1
}

let scanning = false
let scanFinishedAt = 0
let transcriptPath = ''
let timersStarted = false

async function scan($: any) {
  if (scanning) return
  scanning = true
  try {
    const sessionId = String(await $.session.id()).toLowerCase()
    const tp = transcriptPath.split(/[\\/]/).pop()?.toLowerCase() ?? ''
    let sessionFound = false
    // $.env.get exige el nombre como literal: Claude Code rechaza el módulo si es una variable.
    const root = projectsRoot(
      String((await $.env.get('CLAUDE_CONFIG_DIR')) ?? ''),
      String((await $.env.get('USERPROFILE')) ?? ''),
      String((await $.env.get('HOME')) ?? ''),
    )
    const now: number = await $.clock.now()
    const h5 = empty()
    const d7 = empty()
    const session = empty()
    const spark: number[] = new Array(SPARK_SLOTS).fill(0)
    const seen = new Set<string>()
    let skipped = 0
    let sessionSkipped = false
    let lastAt = 0
    let lastCtx = 0
    let ttlMs = 300_000
    const hits: number[] = []
    // Heatmap: 7 días (fila 6 = hoy) × 24 horas locales.
    const heat: number[] = new Array(7 * 24).fill(0)
    const midnight = new Date(now)
    midnight.setHours(0, 0, 0, 0)
    const mid = midnight.getTime()

    // 1) Reunir los logs de los últimos 7 días.
    const candidates: { path: string; name: string; size: number; mtimeMs: number }[] = []
    let dirs: any[] = []
    try {
      dirs = await $.fs.list(root)
    } catch {}
    for (const dir of dirs) {
      if (dir.kind !== 'dir') continue
      let files: any[] = []
      try {
        files = await $.fs.list(`${root}/${dir.name}`)
      } catch {
        continue
      }
      for (const f of files) {
        const name = String(f.name)
        if (!name.endsWith('.jsonl')) continue
        let size = f.size
        let mtimeMs = f.mtimeMs
        if (f.kind !== 'file') {
          try {
            const st = await $.fs.stat(`${root}/${dir.name}/${name}`, { resolve: true })
            if (st.kind !== 'file') continue
            size = st.size
            mtimeMs = st.mtimeMs
          } catch {
            continue
          }
        }
        if (now - mtimeMs > D7) continue
        candidates.push({ path: `${root}/${dir.name}/${name}`, name: name.toLowerCase(), size, mtimeMs })
      }
    }

    // 2) Identificar el log de esta sesión: por id, por la ruta de session.start,
    //    o, si nada coincide, el log modificado más recientemente (el que se está escribiendo).
    let sessionPath =
      candidates.find(c => (!!sessionId && c.name.startsWith(sessionId)) || (!!tp && c.name === tp))?.path ?? ''
    if (!sessionPath && candidates.length) {
      sessionPath = [...candidates].sort((a, b) => b.mtimeMs - a.mtimeMs)[0]!.path
    }
    sessionFound = !!sessionPath
    // La sesión va primero para que la deduplicación no le robe mensajes repetidos en logs reanudados.
    candidates.sort((a, b) => (a.path === sessionPath ? -1 : b.path === sessionPath ? 1 : 0))

    for (const f of candidates) {
      {
        if (f.size > MAX_READ) {
          skipped++
          if (f.path === sessionPath) sessionSkipped = true
          continue
        }
        let text = ''
        try {
          text = await $.fs.read(f.path)
        } catch {
          skipped++
          if (f.path === sessionPath) sessionSkipped = true
          continue
        }
        const isSession = f.path === sessionPath
        for (const line of text.split('\n')) {
          if (!line.includes('"usage"')) continue
          let j: any
          try {
            j = JSON.parse(line)
          } catch {
            continue
          }
          const u = j?.message?.usage
          if (j?.type !== 'assistant' || !u) continue
          if (j.message.model === '<synthetic>') continue
          const key = `${j.message.id}:${j.requestId}`
          if (seen.has(key)) continue
          seen.add(key)
          const ago = now - Date.parse(j.timestamp)
          if (ago <= D7) {
            add(d7, u)
            const at = Date.parse(j.timestamp)
            const dAgo = at >= mid ? 0 : Math.ceil((mid - at) / 86_400_000)
            if (dAgo <= 6) {
              const k = (6 - dAgo) * 24 + new Date(at).getHours()
              heat[k] = (heat[k] ?? 0) + 1
            }
          }
          if (ago <= H5) {
            add(h5, u)
            const slot = SPARK_SLOTS - 1 - Math.floor(Math.max(0, ago) / SLOT_MS)
            if (slot >= 0) spark[slot] = (spark[slot] ?? 0) + 1
          }
          if (isSession) {
            add(session, u)
            {
              const inTok = (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0)
              if (inTok > 0) hits.push((u.cache_read_input_tokens ?? 0) / inTok)
            }
            const ts = Date.parse(j.timestamp)
            if (ts > lastAt) {
              lastAt = ts
              lastCtx = (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0)
              if ((u.cache_creation_input_tokens ?? 0) > 0) {
                ttlMs = (u.cache_creation?.ephemeral_1h_input_tokens ?? 0) > 0 ? 3600_000 : 300_000
              }
            }
          }
        }
      }
    }

    let limits: Stats['limits'] = []
    try {
      limits = (await $.session.usage()).rateLimits
    } catch {}
    scanFinishedAt = await $.clock.now()
    await update($, stats, () => ({ status: 'ready' as const, scannedAt: now, skipped, h5, d7, session, limits, spark, lastAt, ttlMs, lastCtx, sessionFound, sessionSkipped, hits: hits.slice(-INNER), heat }))
  } catch (err: any) {
    await update($, stats, s => ({ ...s, status: 'error' as const, error: String(err?.message ?? err) }))
  } finally {
    scanning = false
  }
}

const fmt = (n: number) => (n >= 1e6 ? `${(n / 1e6).toFixed(2)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}k` : String(n))
const total = (b: Bucket) => b.input + b.cacheRead + b.cacheWrite + b.output

const HEADER = '▓▒░ RAGNOS HUD ░▒▓'
const HEAT = ['∿', '≈', '~', '≈']
const GLITCH = '#%&@!?'
const SPIN = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']
const BEAT = '──────╱╲╱‾╲_──────'

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    transcriptPath = String((e as any).transcript_path ?? '')
    await $.command.register({ name: 'ragnos', description: 'Abre el panel Ragnos HUD de uso de tokens' })
    void $.ui.open({ id: PANE, title: 'RAGNOS', columns: SIDEBAR_W })
    void scan($)
    if (!timersStarted) {
      timersStarted = true
      $.clock.every(60_000, () => void scan($))
      $.clock.every(FRAME_MS, () => void update($, tick, n => (n + 1) % 1_000_000))
    }
    return next(e)
  })

  on('command.run', { command: 'ragnos' }, async $ => {
    await $.ui.open({ id: PANE, title: 'RAGNOS', columns: SIDEBAR_W })
    void scan($)
    return { text: 'Ragnos HUD abierto.' }
  })

  on('turn.complete', async ($, e, next) => {
    void scan($)
    return next(e)
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text } = $.ui.resolve(e)
    const s = await read($, stats)
    const t = await read($, tick)
    const W = SIDEBAR_W
    const inner = INNER

    // Tras cada escaneo, ~1,5 s en que los números cuentan y las barras se llenan.
    const age = (await $.clock.now()) - scanFinishedAt
    const ease = scanFinishedAt ? 1 - Math.pow(1 - Math.min(1, age / 1500), 3) : 1
    const count = (n: number) => fmt(Math.round(n * ease))

    const T = (txt: string, color: Color, o: { bold?: boolean; dim?: boolean; bg?: Color } = {}) => (
      <Text color={color} backgroundColor={o.bg} bold={o.bold} dimColor={o.dim}>
        {txt}
      </Text>
    )
    const edge = (children: any, ec: Color = C.frame, l = '║ ', r = ' ║') => (
      <Box width={W}>
        {T(l, ec, { bold: ec !== C.frame })}
        {children}
        {T(r, ec, { bold: ec !== C.frame })}
      </Box>
    )
    // Bordes de la sección LÍMITES: gruesos y en el color de acento para distinguirla.
    const hot = (children: any) => edge(children, C.accent, '┃ ', ' ┃')
    const frame = (l: string, mid: string, r: string) => <Box width={W}>{T(l + mid.repeat(W - 2) + r, C.frame)}</Box>
    const row = (label: string, value = '', vColor: Color = C.text) =>
      edge([T(label, C.label), T(' '.repeat(Math.max(1, inner - label.length - value.length)) + value, vColor, { bold: true })])

    // Título de sección con un pulso ◆ que recorre la línea.
    const title = (txt: string, i: number) => {
      const head = `╠═[ ${txt} ]`
      const fill = W - head.length - 1
      const pos = (t + i * 7) % (fill + 6)
      const before = Math.min(fill, pos)
      const after = Math.max(0, fill - before - (pos < fill ? 1 : 0))
      return (
        <Box width={W}>
          {T(head, C.accent, { bold: true })}
          {T('═'.repeat(before), C.frame)}
          {pos < fill ? T('◆', C.pulse, { bold: true }) : null}
          {T('═'.repeat(after), C.frame)}
          {T('╣', C.frame)}
        </Box>
      )
    }

    // Barra que se llena animada, con la punta parpadeando.
    // higherIsBetter: para métricas donde un % alto es bueno (aciertos de caché).
    const gauge = (label: string, p: number, higherIsBetter = false) => {
      const shown = p * ease
      const len = inner - label.length - 8
      const n = Math.round((Math.min(100, shown) / 100) * len)
      const c = higherIsBetter
        ? (p >= 80 ? C.ok : p >= 50 ? C.warn : C.bad)
        : (p >= 85 ? C.bad : p >= 60 ? C.warn : C.ok)
      const tip = n > 0 && t % 2 === 0
      return edge([
        T(label + ' ', C.label),
        T('█'.repeat(Math.max(0, n - (tip ? 1 : 0))), c),
        tip ? T('▓', C.text, { bold: true }) : null,
        T('░'.repeat(len - n), C.faint),
        T(`${shown.toFixed(1)}%`.padStart(7), c, { bold: true }),
      ])
    }

    // Sparkline de peticiones por tramo de 15 min; crece al actualizar y la columna actual parpadea.
    const sparkline = () => {
      const data = s.spark.length === SPARK_SLOTS ? s.spark : new Array(SPARK_SLOTS).fill(0)
      const max = Math.max(1, ...data)
      const bars = data.map((v, i) => {
        if (!v) return T('·', C.faint)
        const lvl = Math.min(BARS.length - 1, Math.round((v / max) * ease * (BARS.length - 1)))
        const isNow = i === SPARK_SLOTS - 1
        return T(BARS.charAt(lvl), isNow ? (t % 4 < 2 ? C.accent : C.text) : C.ok, { bold: isNow })
      })
      return edge([T(SPARK_LABEL, C.label), ...bars])
    }

    // Electrocardiograma; late más rápido con más actividad en las últimas 5 h.
    const ekg = () => {
      const speed = s.h5.requests > 50 ? 2 : 1
      const off = (t * speed) % BEAT.length
      let out = ''
      for (let i = 0; i < inner - 6; i++) out += BEAT.charAt((i + off) % BEAT.length)
      return out
    }

    // Cabecera: barrido de luz y un glitch ocasional.
    const glitching = t % 37 < 2
    const sweep = t % (HEADER.length + 8)
    const left = Math.floor((inner - HEADER.length) / 2)
    const header = HEADER.split('').map((ch, i) => {
      const g = glitching && ch !== ' ' && (i * 7 + t) % 4 === 0
      const lit = Math.abs(i - sweep) <= 1
      return T(g ? GLITCH.charAt((i + t) % GLITCH.length) : ch, glitching ? C.bad : lit ? C.text : C.accent, { bold: true })
    })

    const blinkOn = t % 4 < 2
    const [statusText, statusColor]: [string, Color] =
      s.status === 'loading' ? ['CONECTANDO', C.warn] : s.status === 'error' ? ['FALLO DE ENLACE', C.bad] : ['ENLACE ACTIVO', C.ok]
    const statusLine = `${SPIN[t % SPIN.length]} [ ${statusText} ] ${blinkOn ? '●' : '○'}`
    const statusPad = Math.max(0, Math.floor((inner - statusLine.length) / 2))

    const limit = (k: string) => s.limits.find(l => l.kind === k)
    const l5 = limit('five_hour')
    const l7 = limit('seven_day')
    const sec = s.session
    const secIn = sec.input + sec.cacheRead + sec.cacheWrite
    const hit = secIn ? (sec.cacheRead / secIn) * 100 : 0
    const nowMs: number = await $.clock.now()

    // Barra de rate con "ritmo": un marcador ┃ indica cuánto de la ventana ha transcurrido.
    //  - Consumo por detrás del tiempo: el tramo entre el relleno y el marcador sale ▒ (margen libre).
    //  - Consumo por delante: lo que rebasa el marcador se pinta en ámbar/rojo (exceso).
    // El % lleva ▲ (adelantado) o ▼ (con margen) respecto al ritmo esperado.
    const rateGauge = (label: string, l: { percentUsed: number; resetsAt?: string }, windowMs: number) => {
      const box = hot
      const p = Math.min(100, l.percentUsed)
      const resets = l.resetsAt ? Date.parse(l.resetsAt) : NaN
      const elapsed = Number.isFinite(resets) ? Math.max(0, Math.min(1, 1 - (resets - nowMs) / windowMs)) : NaN
      const pctText = `${Math.round(p * ease)}%${Number.isFinite(elapsed) ? (p / 100 > elapsed ? '▲' : p / 100 < elapsed ? '▼' : '=') : ' '}`
      const len = inner - label.length - 1 - 6
      const fill = Math.round(((p * ease) / 100) * len)
      const mark = Number.isFinite(elapsed) ? Math.min(len - 1, Math.round(elapsed * len)) : -1
      const ahead = mark >= 0 && p / 100 > elapsed
      const over = p >= 85 ? C.bad : C.warn
      const cells = []
      for (let i = 0; i < len; i++) {
        if (i === mark) cells.push(T('┃', t % 4 < 3 ? C.text : C.faint, { bold: true }))
        else if (i < fill) cells.push(T('█', ahead && i > mark ? over : C.ok))
        else if (mark >= 0 && i < mark) cells.push(T('▒', C.faint))
        else cells.push(T('░', C.faint))
      }
      const pc = ahead ? over : C.ok
      return box([T(label + ' ', C.text, { bold: true }), ...cells, T(pctText.padStart(6), pc, { bold: true })])
    }

    // Caché: tiempo que sigue caliente (TTL desde la última petición), uso y aciertos.
    const cacheRows = () => {
      const left = s.lastAt ? s.lastAt + s.ttlMs - nowMs : 0
      const ttlLabel = s.ttlMs >= 3600_000 ? '1h' : '5m'
      const rows: any[] = []
      if (left > 0) {
        const frac = left / s.ttlMs
        const c = frac > 0.5 ? C.ok : frac > 0.2 ? C.warn : C.bad
        const secs = Math.ceil(left / 1000)
        const clock = `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')}`
        const heat = HEAT.join('').charAt(t % HEAT.length) + HEAT.join('').charAt((t + 1) % HEAT.length)
        const len = inner - 'calor '.length - heat.length - 1 - clock.length - 1
        const n = Math.round(frac * len)
        rows.push(
          edge([
            T('calor ', C.label),
            T(heat, c, { bold: true }),
            T(' ', C.text),
            T('█'.repeat(n), c),
            T('░'.repeat(len - n), C.faint),
            T(' ' + clock, c, { bold: true, dim: frac <= 0.2 && t % 2 === 0 }),
          ]),
        )
      } else {
        rows.push(row('estado', s.lastAt ? 'FRÍA' : 'sin datos', C.faint))
      }
      rows.push(row('duración', ttlLabel))
      rows.push(row('leído', count(sec.cacheRead)))
      rows.push(row('escrito', count(sec.cacheWrite)))
      rows.push(row('últ. contexto', count(s.lastCtx)))
      rows.push(gauge('acierto', hit, true))
      return rows
    }

    // Aciertos de caché por petición de la sesión (más reciente a la derecha).
    // Alto = casi todo leído de caché; bajo = se reescribió (caché rota). Un haz recorre las
    // columnas, la última parpadea y las barras crecen al actualizar.
    // Tanque de aciertos: el nivel del líquido es el % de entrada leído de caché en las últimas
    // peticiones de la sesión. Lleno = la caché funciona; vacío = se está reescribiendo.
    // La superficie ondula y suben burbujas; el nivel se llena al actualizar.
    const scopeRows = (h: number) => {
      const data = s.hits
      const avg = data.length ? data.reduce((a, b) => a + b, 0) / data.length : 0
      const last = data.length ? data[data.length - 1]! : 0
      const c = avg >= 0.8 ? C.ok : avg >= 0.5 ? C.warn : C.bad
      const level = avg * ease * h * 4
      const label = `${Math.round(avg * ease * 100)}%`
      const labelRow = Math.floor(h / 2)
      const labelAt = Math.floor((inner - label.length) / 2)
      const out: any[] = []
      for (let r = 0; r < h; r++) {
        const base = (h - 1 - r) * 4
        const cells = []
        for (let x = 0; x < inner; x++) {
          const surf = level + (level > 0 ? Math.sin(x * 0.7 + t * 0.9) * 1.3 + Math.sin(x * 0.3 - t * 0.5) * 0.7 : 0)
          const lvl = Math.max(0, Math.min(4, Math.round(surf - base)))
          // Dentro del líquido, el texto y las burbujas se pintan sobre el color del líquido.
          if (r === labelRow && x >= labelAt && x < labelAt + label.length) {
            const ch = label.charAt(x - labelAt)
            cells.push(lvl === 4 ? T(ch, 'inverseText', { bold: true, bg: c }) : T(ch, c, { bold: true }))
            continue
          }
          // Burbujas: suben por columnas fijas a distinto ritmo.
          const bubbleCol = (x * 7) % 5 === 0
          const bubbleRow = h - 1 - ((t + x * 3) % (h + 2))
          const isBubble = bubbleCol && r === bubbleRow && lvl === 4
          if (isBubble) cells.push(T('°', 'inverseText', { bold: true, bg: c }))
          else if (lvl === 4) cells.push(T('█', c))
          else if (lvl > 0) cells.push(T('▁▂▄▆'.charAt(lvl - 1), c, { bold: true }))
          else cells.push(T(r === h - 1 ? '▁' : ' ', C.faint))
        }
        out.push(edge(cells))
      }
      out.push(row(`última ${Math.round(last * 100)}%`, `${data.length} pet.`, last >= 0.8 ? C.ok : last >= 0.5 ? C.warn : C.bad))
      return out
    }

    // Heatmap 7 días × 24 h: aparece en diagonal al actualizar, un haz recorre las horas,
    // la hora actual parpadea y la celda pico titila.
    const DAYS = 'DLMXJVS'
    const HEAT_GLYPHS = '·░▒▓█'
    const HEAT_COLORS: Color[] = [C.faint, C.ok, C.ok, C.accent, C.pulse]
    const heatRows = () => {
      const data = s.heat?.length === 168 ? s.heat : new Array(168).fill(0)
      const top = Math.max(...data)
      const max = Math.max(1, top)
      const peak = top > 0 ? data.indexOf(top) : -1
      const curHour = new Date(nowMs).getHours()
      const beam = t % 32 // 24 columnas + pausa
      const out: any[] = [title('MAPA 7D', 5)]
      for (let r = 0; r < 7; r++) {
        const isToday = r === 6
        const day = new Date(nowMs - (6 - r) * 86_400_000)
        const cells = [T(DAYS.charAt(day.getDay()) + ' ', isToday ? C.accent : C.label, { bold: isToday })]
        for (let h = 0; h < 24; h++) {
          const i = r * 24 + h
          const v = data[i] ?? 0
          if (isToday && h > curHour) {
            cells.push(T(' ', C.faint))
            continue
          }
          // Revelado en diagonal: de arriba-izquierda a abajo-derecha.
          if ((h + r * 2) / 36 > ease * 1.05) {
            cells.push(T(' ', C.faint))
            continue
          }
          const lvl = v ? Math.max(1, Math.ceil((v / max) * 4)) : 0
          if (isToday && h === curHour) {
            cells.push(T(lvl ? HEAT_GLYPHS.charAt(lvl) : '▪', t % 4 < 2 ? C.accent : C.text, { bold: true }))
          } else if (i === peak) {
            cells.push(T(t % 6 < 3 ? '█' : '▓', C.pulse, { bold: true }))
          } else if (h === beam) {
            cells.push(T(HEAT_GLYPHS.charAt(lvl), lvl ? C.text : C.frame, { bold: lvl > 0 }))
          } else {
            cells.push(T(HEAT_GLYPHS.charAt(lvl), HEAT_COLORS[lvl]!))
          }
        }
        out.push(edge(cells))
      }
      // Eje de horas con un ▲ bajo la hora actual.
      const axis = new Array(24).fill(' ')
      for (const [pos, lbl] of [[0, '0'], [6, '6'], [12, '12'], [18, '18']] as const)
        for (let k = 0; k < lbl.length; k++) axis[pos + k] = lbl.charAt(k)
      out.push(
        edge([
          T('  ', C.faint),
          ...axis.map((ch, h) => (h === curHour ? T('▲', C.accent, { bold: t % 4 < 2 }) : T(ch, C.faint))),
        ]),
      )
      const peakTxt = peak >= 0 ? `${DAYS.charAt(new Date(nowMs - (6 - Math.floor(peak / 24)) * 86_400_000).getDay())} ${peak % 24}h · ${top}` : '--'
      out.push(row('pico', peakTxt, C.pulse))
      // Resumen: hoy vs. media de los días con actividad, y la hora más fuerte de la semana.
      const perDay = Array.from({ length: 7 }, (_, r) => data.slice(r * 24, r * 24 + 24).reduce((a, b) => a + b, 0))
      const today = perDay[6]!
      const active = perDay.filter(v => v > 0)
      const avg = active.length ? active.reduce((a, b) => a + b, 0) / active.length : 0
      const trend = !avg ? ' ' : today > avg * 1.1 ? '▲' : today < avg * 0.9 ? '▼' : '='
      const trendColor = trend === '▲' ? C.accent : trend === '▼' ? C.label : C.text
      out.push(
        edge([
          T('hoy ', C.label),
          T(count(today), C.text, { bold: true }),
          T(trend, trendColor, { bold: t % 4 < 2 }),
          T(' '.repeat(Math.max(1, inner - 4 - count(today).length - 1 - `media ${count(Math.round(avg))}`.length)), C.faint),
          T('media ', C.label),
          T(count(Math.round(avg)), C.text, { bold: true }),
        ]),
      )
      const perHour = Array.from({ length: 24 }, (_, h) => perDay.reduce((a, _v, r) => a + (data[r * 24 + h] ?? 0), 0))
      const bestH = Math.max(...perHour) > 0 ? perHour.indexOf(Math.max(...perHour)) : -1
      out.push(row('hora fuerte', `${bestH >= 0 ? `${bestH}:00` : '--'} · ${active.length}/7d`, C.accent))
      return out
    }

    const dur = (ms: number) => {
      const m = Math.max(0, Math.floor(ms / 60_000))
      const d = Math.floor(m / 1440)
      const hh = Math.floor((m % 1440) / 60)
      return d ? `${d}d${String(hh).padStart(2, '0')}h` : hh ? `${hh}h${String(m % 60).padStart(2, '0')}m` : `${m}m`
    }
    const resetIn = (l?: { resetsAt?: string }) => {
      const r = l?.resetsAt ? Date.parse(l.resetsAt) : NaN
      return Number.isFinite(r) ? dur(r - nowMs) : '--'
    }
    const limitsHead = () => {
      const head = '┣━┫ LÍMITES ┣'
      return (
        <Box width={W}>
          {T(head, C.accent, { bold: true })}
          {T('━'.repeat(W - head.length - 1), C.accent, { bold: t % 8 < 4 })}
          {T('┫', C.accent, { bold: true })}
        </Box>
      )
    }
    const limitsSection =
      l5 || l7
        ? [
            limitsHead(),
            ...(l5 ? [rateGauge('5h', l5, H5)] : []),
            ...(l7 ? [rateGauge('7d', l7, D7)] : []),
            hot([
              T('↻ ', C.accent, { bold: true }),
              T(`5h ${resetIn(l5)} · 7d ${resetIn(l7)}`.padEnd(inner - 2), C.label),
            ]),
          ]
        : [limitsHead(), hot(T('sin datos de límites aún'.padEnd(inner), C.faint))]

    const errRows = s.status === 'error' ? [row('> ERR ' + (s.error ?? '').slice(0, inner - 6), '', C.bad)] : []
    const v5hRows = [
      title('VENTANA 5H', 0),
      row('peticiones', count(s.h5.requests)),
      row('tokens', count(total(s.h5))),
      sparkline(),
      edge([T('pulso ', C.label), T(ekg(), s.h5.requests ? C.ok : C.faint)]),
    ]
    const full =
      s.status === 'loading'
        ? [row(`> conectando${'.'.repeat(t % 4)}`, '', C.warn)]
        : [
            ...errRows,
            ...limitsSection,
            ...v5hRows,
            title('SEMANA 7D', 1),
            row('peticiones', count(s.d7.requests)),
            row('tokens', count(total(s.d7))),
            title('SESIÓN', 2),
            ...(s.sessionFound ? [] : [row('log sesión', 'no encontrado', C.bad)]),
            ...(s.sessionSkipped ? [row('log sesión', '>4MiB omitido', C.warn)] : []),
            row('peticiones', count(sec.requests)),
            row('tokens', count(total(sec))),
            title('CACHÉ', 3),
            ...cacheRows(),
            ...(s.skipped ? [row('logs >4MiB', `omitidos ${s.skipped}`, C.warn)] : []),
          ]

    // Distribución según el alto disponible (4 filas de marco y cabecera + 1 de margen):
    //  1) completo + mapa (+ tanque si sobra)
    //  2) intermedio: LÍMITES + VENTANA 5H + mapa (sin 7D, sesión ni caché)
    //  3) completo sin mapa
    //  4) compacto: LÍMITES + calor y aciertos de la caché
    const HEAT_H = 12
    const vpRows = e.viewport?.rows ?? 0
    const ready = s.status !== 'loading'
    const fits = (n: number) => vpRows <= 0 || 4 + n + 1 <= vpRows
    const mid = [...errRows, ...limitsSection, ...v5hRows]
    let body: any[]
    let withHeat = false
    if (!ready) body = full
    else if (vpRows > 0 && fits(full.length + HEAT_H)) {
      body = full
      withHeat = true
    } else if (vpRows > 0 && fits(mid.length + HEAT_H)) {
      body = mid
      withHeat = true
    } else if (fits(full.length)) body = full
    else {
      const cr = cacheRows()
      body = [...errRows, ...limitsSection, title('CACHÉ', 3), cr[0], cr[cr.length - 1]]
    }
    const heatmap = withHeat ? heatRows() : []

    // Tanque de aciertos solo con el panel completo y alto sobrante.
    const spare = vpRows - 4 - body.length - heatmap.length - 1
    const avail = Math.min(8, spare)
    const scope = ready && body === full && avail >= 4 ? [title('ACIERTOS', 4), ...scopeRows(avail - 2)] : []

    return (
      <Box flexDirection="column" width={W} flexShrink={0} flexGrow={0}>
        {frame('╔', '═', '╗')}
        {edge([T(' '.repeat(left), C.accent), ...header, T(' '.repeat(Math.max(0, inner - left - HEADER.length)), C.accent)])}
        {edge(T((' '.repeat(statusPad) + statusLine).padEnd(inner), statusColor, { bold: true, dim: !blinkOn }))}
        {body}
        {heatmap}
        {scope}
        {frame('╚', '═', '╝')}
      </Box>
    )
  })
}

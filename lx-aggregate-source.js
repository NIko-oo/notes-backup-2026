/*!
 * @name 聚合音源-多接口自动切换
 * @description 聚合多个实测可用的公益接口，按优先级自动切换、失败回退。支持 QQ/网易云/酷我/酷狗。v1.3 新增 zddyr 全平台备用与酷我官方 mobi 接口。启动时异步自检版本，有新版弹更新提醒。接口配置集中在下方 APIS 与 CHAINS，可自行增删排序。
 * @version 1.3.0
 * @author Qoder
 * @support tx wy kw kg
 */

const { EVENT_NAMES, request, on, send } = globalThis.lx

// 单次请求超时（毫秒）。某个接口卡住时，超过该时间自动切到下一个。
const TIMEOUT = 12000
const DEV_ENABLE = false

// 是否打印命中日志（调试用）
const LOG = true

// 当前脚本版本（与头部 @version 保持一致）
const SCRIPT_VERSION = '1.3.0'
// 版本自检：依次尝试这些 version.json 地址（raw 无缓存优先），任一成功即停止；失败不影响正常使用
const UPDATE_CHECK_URLS = [
  'https://raw.githubusercontent.com/NIko-oo/lx-aggregate-source/main/version.json',
  'https://ghproxy.net/https://raw.githubusercontent.com/NIko-oo/lx-aggregate-source/main/version.json',
  'https://fastly.jsdelivr.net/gh/NIko-oo/lx-aggregate-source@main/version.json',
]
const UPDATE_SCRIPT_URL = 'https://raw.githubusercontent.com/NIko-oo/lx-aggregate-source/main/lx-aggregate-source.js'

/* ============================ 接口配置 ============================ */
// 每个接口：name 显示名；build(source, id, quality, musicInfo) 返回 { url, method?, headers?, body? }
// 响应取链由统一的 pickUrl 处理，无需各接口单独写解析。

// cyapi 的公开 key（来自「收集の聚合接口」，可按需替换）
const CYAPI_KEY = '1ffdf5733f5d538760e63d7e46ba17438d9f7b9dfc18c51be1109386fd74c3a1'

// 音质映射：LX 音质 -> 各接口自身参数
const HUIBQ_Q = { '128k': '128k', '320k': '320k', flac: '320k', flac24bit: '320k' } // Huibq 最高 320k
const CIALLO_YZ = { '128k': 1, '320k': 2, flac: 3, flac24bit: 4 }
const OIAPI_KW_BR = { '128k': 7, '320k': 5, flac: 1, flac24bit: 1 }
const CQ_KW_LEVEL = { '128k': 'standard', '320k': 'exhigh', flac: 'lossless', flac24bit: 'lossless' }
// 酷我官方 mobi 接口的码率参数
const MOBI_KW_BR = { '128k': '128kmp3', '320k': '320kmp3', flac: '2000kflac', flac24bit: '4000kflac' }
// zddyr 聚合接口的平台名映射（tx 需卡密，不接入）
const ZDDYR_SOURCE = { wy: 'netease', kg: 'kg', kw: 'kuwo' }

const APIS = {
  // QQ音乐：cyapi，速度快，返回默认音质
  cyapi: {
    name: 'cyapi(QQ)',
    build: (s, id) => ({ url: `https://cyapi.top/API/qq_music.php?apikey=${CYAPI_KEY}&type=json&mid=${id}` }),
  },
  // 全平台兜底主干：tx/wy/kw/kg 均可，wy/kg 会跨平台用酷我后端解析（版权受限歌也能出链）
  huibq: {
    name: 'Huibq',
    build: (s, id, q) => ({
      url: `https://lxmusicapi.onrender.com/url/${s}/${id}/${HUIBQ_Q[q] || '320k'}`,
      headers: { 'X-Request-Key': 'share-v3' },
    }),
  },
  // ikun 公益：kw/wy/kg，支持高音质（网易云版权受限歌会返回空，自动回退）
  ikun: {
    name: 'ikun',
    build: (s, id, q) => ({
      url: 'https://c.wwwweb.top/music/url',
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Api-Key': '' },
      body: JSON.stringify({ source: s, musicId: id, quality: q }),
    }),
  },
  // Ciallo：仅网易云，全音质
  ciallo: {
    name: 'Ciallo',
    build: (s, id, q) => ({ url: `https://api.s0o1.com/API/wyy_music?id=${id}&yz=${CIALLO_YZ[q] || 3}` }),
  },
  // 溯音网易云
  oiapi163: {
    name: '溯音163',
    build: (s, id) => ({ url: `https://oiapi.net/api/Music_163?id=${id}` }),
  },
  // 长青酷我模板：直接返回播放链接文本
  changqingKw: {
    name: '长青酷我',
    build: (s, id, q) => ({ url: `https://musicapi.haitangw.net/music/kw.php?id=${id}&level=${CQ_KW_LEVEL[q] || 'lossless'}` }),
  },
  // 溯音酷我：按歌名搜索匹配，精度略低，放最后兜底
  oiapiKuwo: {
    name: '溯音酷我(搜索)',
    build: (s, id, q, mi) => ({
      url: `https://oiapi.net/api/Kuwo?msg=${encodeURIComponent((mi.name || '') + ' ' + (mi.singer || ''))}&n=1&br=${OIAPI_KW_BR[q] || 1}`,
    }),
  },
  // zddyr 聚合（来自墨澜音源）：wy/kg/kw 备用，直连各平台 CDN，速度快；tx 需卡密不接入
  zddyr: {
    name: 'zddyr(备用)',
    build: (s, id, q) => ({
      url: `https://yy.zddyr.top/lx/api/?source=${ZDDYR_SOURCE[s] || s}&songmid=${id}&quality=${q}`,
    }),
  },
  // 酷我官方 mobi 接口（来自墨澜音源）：kw 备用，返回 data.surl，需移动端 UA
  mobiKuwo: {
    name: '酷我官方mobi',
    build: (s, id, q) => ({
      url: `https://mobi.kuwo.cn/mobi.s?f=web&rid=${id}&br=${MOBI_KW_BR[q] || '320kmp3'}&source=jiakong&type=convert_url_with_sign&surl=1`,
      headers: { 'User-Agent': 'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.114 Mobile Safari/537.36' },
    }),
  },
}

// 每个平台的接口尝试顺序（从前到后，命中即返回）
const CHAINS = {
  tx: ['cyapi', 'huibq'],
  wy: ['ciallo', 'ikun', 'oiapi163', 'zddyr', 'huibq'],
  kw: ['ikun', 'huibq', 'changqingKw', 'mobiKuwo', 'zddyr', 'oiapiKuwo'],
  kg: ['ikun', 'zddyr', 'huibq'],
}

// 各平台对外声明支持的音质
const QUALITYS = {
  tx: ['128k', '320k'],
  wy: ['128k', '320k', 'flac', 'flac24bit'],
  kw: ['128k', '320k', 'flac', 'flac24bit'],
  kg: ['128k', '320k', 'flac'],
}
const SOURCE_NAMES = { tx: 'QQ音乐', wy: '网易云音乐', kw: '酷我音乐', kg: '酷狗音乐' }

/* ============================ 工具 ============================ */
const isUrl = u => typeof u === 'string' && /^https?:\/\//.test(u.trim())

// 统一从多种响应结构里提取播放链接：
// body.url / body.data.url / body.data.surl / body.data(字符串) / body.music / body.musicInfo / body.data[0].url / 纯文本URL
const pickUrl = body => {
  if (typeof body === 'string') return isUrl(body) ? body.trim() : null
  if (!body || typeof body !== 'object') return null
  const candidates = [body.url, body.data && body.data.url, body.data && body.data.surl, body.data, body.music, body.musicInfo, Array.isArray(body.data) && body.data[0] && body.data[0].url]
  for (const c of candidates) if (isUrl(c)) return c.trim()
  return null
}

const httpFetch = (url, options = {}, timeout = TIMEOUT) => new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error('请求超时')), timeout)
  request(url, { method: 'GET', timeout, ...options }, (err, resp) => {
    clearTimeout(timer)
    if (err) return reject(err)
    resolve(resp)
  })
})

// 从 musicInfo 里稳健地取出各平台歌曲 ID
const getId = (source, mi) => {
  const meta = mi.meta || {}
  switch (source) {
    case 'kg': return mi.hash || meta.hash || mi.songmid
    case 'wy': return meta.songId || mi.songmid || mi.id
    case 'kw': return mi.songmid || meta.songId || mi.id
    case 'tx': return mi.songmid || meta.songmid || mi.id
    default: return mi.songmid || mi.id
  }
}

/* ============================ 核心 ============================ */
const getMusicUrl = async (source, musicInfo, quality) => {
  const id = String(getId(source, musicInfo) ?? '')
  if (!id && source !== 'kw') throw new Error('缺少歌曲ID')
  const chain = CHAINS[source] || []
  const errs = []
  for (const key of chain) {
    const api = APIS[key]
    if (!api) continue
    try {
      const req = api.build(source, id, quality, musicInfo)
      const resp = await httpFetch(req.url, { method: req.method || 'GET', headers: req.headers, body: req.body })
      const url = pickUrl(resp.body)
      if (url) {
        if (LOG) console.log(`[聚合音源] ${source}/${quality} 命中 ${api.name}`)
        return url
      }
      errs.push(api.name + ':无链接')
    } catch (e) {
      errs.push(api.name + ':' + (e.message || e))
    }
  }
  throw new Error(`所有接口失败(${source}/${quality}): ` + errs.join(' | '))
}

/* ============================ 版本自检 ============================ */
// 比较版本号，a > b 时返回 true
const compareVersions = (a, b) => {
  const pa = String(a).split('.').map(n => parseInt(n, 10) || 0)
  const pb = String(b).split('.').map(n => parseInt(n, 10) || 0)
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] || 0, y = pb[i] || 0
    if (x > y) return true
    if (x < y) return false
  }
  return false
}

// 启动后异步检查更新；任何失败都静默跳过，绝不阻塞或影响取链
const checkUpdate = async () => {
  for (const url of UPDATE_CHECK_URLS) {
    try {
      const resp = await httpFetch(url, { method: 'GET' }, 8000)
      const data = typeof resp.body === 'string' ? JSON.parse(resp.body) : resp.body
      if (data && data.version) {
        if (compareVersions(data.version, SCRIPT_VERSION)) {
          send(EVENT_NAMES.updateAlert, {
            log: `发现新版本 v${data.version}（当前 v${SCRIPT_VERSION}）\n\n${data.log || ''}`,
            updateUrl: data.updateUrl || UPDATE_SCRIPT_URL,
            confirmText: '立即更新',
            cancelText: '暂不更新',
          })
        }
        return
      }
    } catch (e) {
      // 当前地址失败，尝试下一个
    }
  }
}

/* ============================ 注册 ============================ */
const sources = {}
for (const s of Object.keys(CHAINS)) {
  sources[s] = { name: SOURCE_NAMES[s], type: 'music', actions: ['musicUrl'], qualitys: QUALITYS[s] }
}

on(EVENT_NAMES.request, ({ action, source, info }) => {
  if (action !== 'musicUrl') return Promise.reject(new Error('不支持的 action: ' + action))
  return getMusicUrl(source, info.musicInfo, info.type)
})

send(EVENT_NAMES.inited, {
  openDevTools: DEV_ENABLE,
  sources,
})

// 初始化完成后异步检查更新（不阻塞取链）
checkUpdate()
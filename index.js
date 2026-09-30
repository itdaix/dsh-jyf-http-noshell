/**
 * dsh-jyf-http-noshell —— 通用 HTTP 请求工具
 *
 * 一个工具，参数全部由调用方指定：
 *   url / method / username / password / body
 * 请求固定用 `application/json`，认证固定用 BASIC AUTH，方法限 GET / POST / PUT / DELETE。
 *
 * 归属：本插件只往 host 的 `tools` 注册表注册工具，不发布任何服务，
 * 因此不需要 isolate realm，也不改动出厂的 host / preset 文件。
 * 装在 profile 层，所以这份能力对 profile 内每个会话都可见。
 *
 * @module dsh-jyf-http-noshell
 */

/* ────────────────────────────── 配置 ────────────────────────────── */

const DEFAULTS = {
  /** 单次请求超时（毫秒）。 */
  timeoutMs: 30000,
  /** 响应体保留上限（字节），超出截断并标注。 */
  maxResponseBytes: 1048576,
}

/**
 * Cordis 只认 Standard Schema：加载时会调用 `Config['~standard'].validate(raw)`
 * （见 vendor/cordis 的 `resolveConfig`）。普通「字段→默认值」的 map 会在加载时报
 * `Cannot read properties of undefined (reading 'validate')`。
 */
function normalizeConfig(raw) {
  const input = raw !== null && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}
  const issues = []
  const value = { ...DEFAULTS }

  for (const key of ['timeoutMs', 'maxResponseBytes']) {
    const given = input[key]
    if (given === undefined || given === null) continue
    const number = typeof given === 'number' ? given : Number(given)
    if (!Number.isFinite(number) || number <= 0) {
      issues.push({ message: `${key} 必须是正数`, path: [key] })
      continue
    }
    value[key] = number
  }

  return issues.length > 0 ? { issues } : { value }
}

/** 插件配置（Standard Schema 形态）。 */
export const Config = {
  '~standard': {
    version: 1,
    vendor: 'dsh-jyf-http-noshell',
    validate: normalizeConfig,
  },
}

/** 只依赖工具注册表。 */
export const inject = ['tools']

/* ────────────────────────────── 请求 ────────────────────────────── */

const METHODS = ['GET', 'POST', 'PUT', 'DELETE']

/** 去掉 markdown 代码围栏，便于容错解析 JSON。 */
function stripFence(text) {
  const trimmed = text.trim()
  const match = /^```[a-zA-Z]*\s*\r?\n([\s\S]*?)\r?\n?```$/.exec(trimmed)
  return match ? match[1] : trimmed
}

/**
 * 判定业务成败（既定规则）：返回单个对象 = 成功；返回数组 = 失败，数组即错误清单。
 * @param parsed - 已解析的响应体。
 * @returns 成败与理由。
 */
function classify(parsed) {
  if (Array.isArray(parsed)) return { success: false, reason: '返回的是数组，按规则视为失败；数组内容就是错误清单' }
  if (parsed !== null && typeof parsed === 'object') return { success: true, reason: '返回单个对象，按规则视为成功' }
  if (parsed === null) return { success: false, reason: '返回 null，无法判定为成功对象' }
  return { success: false, reason: `返回的是 ${typeof parsed}，不是对象` }
}

/** 安全 JSON 化：深结构或循环引用不会抛。 */
function toJsonSafe(value) {
  try {
    return JSON.parse(JSON.stringify(value))
  } catch {
    return String(value)
  }
}

/** 把网络层异常翻译成可执行的提示 + 原始错误。 */
function describeNetworkError(error, timeoutMs) {
  const message = error instanceof Error ? error.message : String(error)
  const code = error && error.cause && error.cause.code ? ` (${error.cause.code})` : ''
  const hint = /timeout|timed out|aborted/i.test(message)
    ? `请求超时（超过 ${timeoutMs}ms）。`
    : /ENOTFOUND|EAI_AGAIN/.test(message)
      ? '域名解析失败，检查 URL 与网络。'
      : /CERT|self.signed|UNABLE_TO_VERIFY|SSL/i.test(message)
        ? 'TLS 证书校验失败。'
        : /ECONNREFUSED/.test(message)
          ? '连接被拒绝，检查服务是否在运行、端口是否正确。'
          : /Invalid URL|Failed to parse URL/i.test(message)
            ? 'URL 不合法，需要完整的 http(s):// 地址。'
            : '请求未能发出。'
  return `${hint}原始错误：${message}${code}`
}

/**
 * 发一次请求。任何失败都返回结构化的 { ok:false, error }，不抛出。
 *
 * 刻意不使用 ctx.web.fetch：那个服务是「公网地址钉扎」的抓取器，只支持 GET，
 * 且会拒绝内网地址；本工具要打的是内网/测试域的 REST 接口，必须用本进程的 fetch。
 */
async function request({ config, url, method, username, password, body }) {
  const started = Date.now()
  let target
  try {
    target = new URL(url)
  } catch {
    return { ok: false, error: `URL 不合法：${url}。需要完整的 http(s):// 地址。` }
  }
  if (target.protocol !== 'http:' && target.protocol !== 'https:') {
    return { ok: false, error: `不支持的协议「${target.protocol}」，只支持 http / https。` }
  }

  const headers = {
    accept: 'application/json, text/plain, */*',
    // BASIC AUTH：用户名与密码直接来自入参。
    authorization: `Basic ${Buffer.from(`${username}:${password}`, 'utf8').toString('base64')}`,
  }
  const init = {
    method,
    headers,
    // 不跟随重定向：凭据不能因为一次 3xx 被送到别的主机。
    redirect: 'manual',
    signal: AbortSignal.timeout(Math.max(1000, config.timeoutMs)),
  }
  if (method !== 'GET' && body !== undefined) {
    headers['content-type'] = 'application/json; charset=utf-8'
    init.body = typeof body === 'string' ? body : JSON.stringify(body)
  }

  // 返回里只回显 host + path，不回显可能带 token 的查询串。
  const shown = `${target.origin}${target.pathname}`
  const result = {
    ok: true,
    url: shown,
    method,
    httpStatus: null,
    success: false,
    durationMs: 0,
    response: null,
    note: undefined,
    truncated: false,
  }

  let response
  try {
    response = await fetch(target, init)
  } catch (error) {
    return { ok: false, error: describeNetworkError(error, config.timeoutMs), url: shown, method }
  }

  result.httpStatus = response.status
  let text = ''
  try {
    text = await response.text()
  } catch (error) {
    return { ok: false, error: `读取响应体失败：${error instanceof Error ? error.message : String(error)}`, httpStatus: response.status, url: shown, method }
  }
  result.durationMs = Date.now() - started

  const cap = Math.max(1024, config.maxResponseBytes)
  const bytes = Buffer.byteLength(text, 'utf8')
  if (bytes > cap) {
    text = `${Buffer.from(text, 'utf8').subarray(0, cap).toString('utf8')}\n…（响应体 ${bytes} 字节，超过上限 ${cap}，已截断）`
    result.truncated = true
  }

  let parsed
  try {
    parsed = JSON.parse(stripFence(text))
  } catch {
    parsed = undefined
  }

  if (parsed === undefined) {
    result.success = false
    result.response = { kind: 'text', raw: text.slice(0, 8000) }
    result.note = response.ok ? '响应不是 JSON。' : `HTTP ${response.status}，响应不是 JSON。`
    return result
  }

  const verdict = classify(parsed)
  result.response = { kind: 'json', payload: toJsonSafe(parsed) }
  if (!response.ok) {
    result.success = false
    result.note = `HTTP ${response.status} ${response.statusText}，按失败处理。`
  } else {
    result.success = verdict.success
    result.note = verdict.reason
  }
  return result
}

/* ────────────────────────────── 工具注册 ────────────────────────────── */

/**
 * 把作者写法的参数表编译成注册表要的形状。
 *
 * `ToolRuntime.register` 会对 `parameters` 与 `output.schema` 直接跑
 * `assertSupportedJsonSchema`，只认原始 JSON Schema 子集：
 *   - 属性节点上**不能**写 `required: true`，必填只能落在对象根的 `required` 数组里；
 *   - 输出的 `type` 必须是 object/array/string/number/integer/boolean/null 之一。
 */
function compileParameters(spec) {
  const properties = {}
  const required = []
  for (const [key, raw] of Object.entries(spec ?? {})) {
    const node = { ...raw }
    if (node.required === true) {
      required.push(key)
      delete node.required
    }
    properties[key] = node
  }
  return { type: 'object', properties, ...(required.length > 0 ? { required } : {}) }
}

/** 模块级配置，apply 时赋值。 */
let activeConfig = { ...DEFAULTS }

/** 工具定义。 */
const httpTool = {
  name: 'http_request_noshell',
  description: [
    '发一个 HTTP 请求。方法、URL、BASIC AUTH 的用户名与密码全部由参数指定。',
    '支持 GET / POST / PUT / DELETE；请求体是 JSON（Content-Type: application/json）。',
    '判定规则：响应解析出单个对象 {} 视为成功；解析出数组 [{...}] 视为失败，数组内容就是错误清单。',
    '不跟随重定向；失败不会自动重试 —— 把失败事实交给用户决定。',
  ].join(' '),
  parameters: compileParameters({
    url: { type: 'string', required: true, description: '完整请求地址，含 http(s):// 与路径，例如 https://host/api/order/list' },
    method: { type: 'string', required: true, enum: METHODS, description: '请求方法：GET / POST / PUT / DELETE' },
    username: { type: 'string', required: true, description: 'BASIC AUTH 用户名' },
    password: { type: 'string', required: true, description: 'BASIC AUTH 密码（不会出现在返回内容里）' },
    body: { type: 'object', additionalProperties: true, description: 'POST / PUT 的 JSON 请求体；GET / DELETE 可不传' },
  }),
  output: {
    schema: { type: 'object', additionalProperties: true },
    render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
  },
  async execute(args) {
    const url = String(args.url ?? '').trim()
    const method = String(args.method ?? '').trim().toUpperCase()
    const username = String(args.username ?? '')
    const password = String(args.password ?? '')

    if (url.length === 0) return { ok: false, error: 'url 不能为空。' }
    if (!METHODS.includes(method)) {
      return { ok: false, error: `method 必须是 ${METHODS.join(' / ')} 之一，收到「${args.method ?? ''}」。` }
    }
    if (username.length === 0) return { ok: false, error: 'username 不能为空。' }
    if (password.length === 0) return { ok: false, error: 'password 不能为空。' }

    try {
      return await request({ config: activeConfig, url, method, username, password, body: args.body })
    } catch (error) {
      return { ok: false, error: `请求异常：${error instanceof Error ? error.message : String(error)}` }
    }
  },
}

/**
 * 注册工具。
 * @param ctx - 提供 `tools` 注册表的宿主上下文。
 * @param config - 已校验并填好默认值的插件配置。
 */
export function apply(ctx, config) {
  activeConfig = config ?? { ...DEFAULTS }
  ctx.tools.register(httpTool)
}

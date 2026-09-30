# dsh-jyf-http-noshell

## 一句话简介

一个通用 HTTP 请求工具（单个工具 `http_request_noshell`）：请求方法、URL、BASIC AUTH 账号密码、请求体全部由调用方在入参里指定，请求固定用 `application/json`，认证固定用 BASIC AUTH，方法限 GET / POST / PUT / DELETE。

## 技术选型

| 维度 | 选型 | 说明 |
| --- | --- | --- |
| 语言 | 纯 JavaScript（ES Module） | 单文件 index.js，无第三方运行时依赖 |
| 插件框架 | Cordis（Standard Schema Config） | 配置走 `~standard.validate` 校验 |
| 依赖注入 | 仅 `tools` 注册表 | 只注册工具，不发布服务，不改 host / preset |
| HTTP 客户端 | 本进程 `fetch` | 不用 `ctx.web.fetch`（公网钉扎、只 GET、拒内网） |
| 认证 | BASIC AUTH | `username:password` 经 UTF-8 转 base64 |
| 超时 | `AbortSignal.timeout` | 默认 30000ms，下限 1000ms |
| JSON 解析 | 容错解析（先剥代码围栏） | 解析失败按纯文本处理 |

## 核心流程

### 阶段一：收参与校验

1. 拿到调用方传的 5 个入参：url、method、username、password、body
2. 把 url / method / username / password 逐个转成字符串，method 去掉首尾空格再转大写
3. 校验 url 为空 → 停下，回「url 不能为空」
4. 校验 method 不是 GET/POST/PUT/DELETE 之一 → 停下，回「method 必须是 …」
5. 校验 username 为空 → 停下，回错误；password 为空 → 停下，回错误
6. 全部通过 → 交回给下一步「拼请求」

### 阶段二：拼请求

7. 解析 url 成标准地址，解析失败 → 停下，回「URL 不合法，需要完整 http(s):// 地址」
8. 检查协议，不是 http/https → 停下，回「不支持的协议，只支持 http / https」
9. 把 `username:password` 按 UTF-8 拼起来，做 base64 编码，拼成 `Authorization: Basic` 头
10. 拼出 `accept` 头（application/json, text/plain, */*）
11. 拼出请求配置：方法 + 两个头 + 不跟随重定向 + 超时信号（默认 30000ms，下限 1000ms）
12. 若方法不是 GET 且带了 body：补 `Content-Type: application/json`，把 body 转成 JSON 字符串
13. 拼出回显地址 = 协议 + 主机 + 路径，故意丢掉可能带 token 的查询串

### 阶段三：发请求、收响应

14. 记下开始时间
15. 异步用本进程 fetch 发出请求；网络异常 → 停下，把错误翻译成人话（超时 / 域名解析失败 / 证书失败 / 连接拒绝 / URL 非法 五类）
16. 记下 HTTP 状态码
17. 异步读出响应体文本，读取失败 → 停下，回错误
18. 算耗时 = 当前时间 − 开始时间
19. 按字节数比上限（默认 1MB，最小 1KB），超出 → 截断并标「已截断」

### 阶段四：解析与判定

20. 剥掉可能包着的 markdown 代码围栏，再试 JSON 解析；解析失败 → 当「不是 JSON」处理
21. 不是 JSON → 成败置 false，响应按纯文本存（只留前 8000 字符），备注说明「响应不是 JSON」
22. 是 JSON → 按规则判定：单个对象 = 成功；数组 = 失败（数组即错误清单）；null 或标量 = 失败
23. 再看 HTTP 状态：非 2xx → 强制按失败，备注带状态码与状态短语
24. 2xx → 成败采用上面判定结果，备注记判定理由

### 阶段五：返回结果

25. 把结果结构化返回：ok / 地址 / 方法 / 状态码 / 成败 / 耗时 / 响应 / 备注 / 是否截断
26. 把结果渲染成 JSON 文本，交回给用户

### 阶段六：注册工具

27. 插件加载（apply）时，把配置存进模块级；没配就用默认值（超时 30000ms、上限 1MB）
28. 把 `http_request_noshell` 工具注册进 host 的 `tools` 注册表，对 profile 内每个会话可见
29. 把入参表编译成 JSON Schema（必填字段收进根级 required 数组），交注册表校验

## 入参

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| url | string | 是 | 完整请求地址，含 http(s):// 与路径 |
| method | string | 是 | GET / POST / PUT / DELETE |
| username | string | 是 | BASIC AUTH 用户名 |
| password | string | 是 | BASIC AUTH 密码（不回显在返回里） |
| body | object | 否 | POST / PUT 的 JSON 请求体；GET / DELETE 可不传 |

## 配置项

| 配置 | 默认值 | 说明 |
| --- | --- | --- |
| timeoutMs | 30000 | 单次请求超时（毫秒） |
| maxResponseBytes | 1048576 | 响应体保留上限（字节），超出截断并标注 |

## 关键设计点

1. **用本进程 `fetch`，不用 `ctx.web.fetch`** —— 后者是公网地址钉扎的抓取器、只支持 GET、且拒绝内网；本工具要打的是内网 / 测试域 REST 接口。
2. **不跟随重定向**（`redirect: manual`）—— 避免凭据被一次 3xx 带到别的主机。
3. **成败用业务规则判定，而不是 HTTP 状态** —— 单个对象 = 成功、数组 = 失败（数组即错误清单）；HTTP 非 2xx 仍强制失败。
4. **失败全部结构化返回（`{ok:false, error}`）、不抛异常** —— 把失败事实交回调用方决定，不自动重试。
5. **网络错误翻译成可执行的中文提示** —— 覆盖超时 / DNS / 证书 / 连接拒绝 / URL 非法五类。
6. **防泄漏与保护** —— 回显地址去掉查询串（防 token）、响应体截断（防爆内存）、JSON 深结构安全化（防循环引用抛错）。

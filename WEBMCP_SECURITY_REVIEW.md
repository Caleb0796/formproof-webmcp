# FormProof WebMCP 安全问题报表与修复计划

> 审计结论：当前没有确认的 Critical 漏洞；确认 1 项 High、3 项 Medium、4 项 Low 安全问题，另有 1 项 Low 正确性缺陷、1 项尚未证明造成实际伤害的 hardening 候选，以及 3 项必须由产品威胁模型或真实部署证据裁决的条件性风险。最高优先级问题不是签名分级，而是未受信任 PDF 中可达的 JavaScript 和嵌入附件等未验证载荷会被保留到写入新 PII 的输出 PDF。

## 1. 审计快照

| 项目 | 值 |
| --- | --- |
| 审计时间 | 2026-08-31 03:10 UTC |
| 基准提交 | `32257f89a93bb8968452bb8923b3051be33eeac2` |
| 工作树 | 同时审阅了当前 7 个未提交修改文件；结论不是只针对 HEAD |
| 审计方式 | 主审 + 3 路独立 Daybreak Blue 对抗审阅；静态追踪、单元测试、合成恶意 PDF/填表包安全复现 |
| 本轮动作 | 只生成安全报告和修复计划；没有修改产品代码、没有部署、没有公开仓库 |
| 基线检查 | `pnpm test`：264/264 通过，0 失败；`pnpm typecheck`：通过 |

当前未提交修改属于之前正在进行的保护分级工作，涉及：

- `components/formproof-workbench.tsx`
- `evals/tools.json`
- `lib/form-state.ts`
- `lib/webmcp.ts`
- `scripts/benchmark-real-pdfs.ts`
- `tests/form-state.test.ts`
- `tests/webmcp.test.ts`

本报告中的行号和行为均以这个快照为准。修复执行者开始前必须重新读取当前 diff；不要覆盖或回退这些既有修改。
未跟踪的 `tmp/` 只作为本地实验材料存在，不属于报告交付物，也不得进入提交。

## 2. 结论摘要

### 2.1 已确认问题

| ID | 严重度 | 问题 | 可信度 | 修复优先级 |
| --- | --- | --- | --- | --- |
| SEC-01 | **High** | 可达 JavaScript 和嵌入附件等未验证 PDF 载荷可随填好后的 PDF 保留 | High | P0 |
| SEC-02 | **Medium** | 同一 PDF 重新载入会产生 `sourceHash + stateVersion` 的 ABA，旧 WebMCP 请求可命中新会话 | High | P1 |
| SEC-03 | **Medium** | 压缩流可在资源预算生效前由 `pdf-lib` 解码，造成内存/响应性攻击 | High | P1 |
| SEC-04 | **Low** | Agent 可自选 `user_instruction`/`source_document` provenance，误导来源标签和风险说明；未绕过逐字段确认 | High | P2 |
| SEC-05 | **Medium** | 低于 4 MiB 的恶意填表包可携带海量 evidence，导入后让审核 UI 创建数十万节点 | High | P1 |
| SEC-06 | **Low** | 重放 `start_fill_review` 会重置人工确认与导出选择 | High | P2 |
| SEC-07 | **Low** | WebMCP 顺序注册完成前，React 卸载拿不到取消句柄 | High | P2 |
| SEC-08 | **Low** | 双 `requestAnimationFrame` 可使隐藏页面中的已取消工具调用永久不结算 | High | P2 |

### 2.2 已确认的相邻缺陷与待验证 hardening

| ID | 分类 | 结论 | 当前状态 |
| --- | --- | --- | --- |
| ROB-01 | **Low 正确性/互操作** | 系统能导出超过自身 4 MiB 导入上限的填表包 | 已复现；不是权限或保密绕过 |
| HARD-01 | **待验证 hardening** | 单文档累计暂存计划没有总预算 | 已证明“没有总预算”，尚未证明冻结、OOM 或不可接受延迟；测量后再决定是否修 |

### 2.3 条件性风险与决策门

| ID | 条件严重度 | 结论 | 当前状态 |
| --- | --- | --- | --- |
| TM-01 | **High（若要求可证明的人类在场）** | 普通按钮、单选框和复选框只能证明 WebMCP 没有直接的批准工具，不能证明点击者是人 | 产品威胁模型尚未明确 |
| PRIV-01 | **Medium（隐私策略）** | 工具自动注册，当前文档的源值/有效值可被读取；没有每文档、默认关闭的数据共享授权 | 行为已确认，是否接受需产品决定 |
| DEPLOY-01 | **Medium（若线上响应可被 framing）** | 仓库构建产物没有反点击劫持安全头；私有部署的已认证响应尚未验证 | 不能仅凭未认证的 401 响应下结论 |

### 2.4 不应被误报的问题

以下候选经过追踪或测试后没有形成当前可利用漏洞，不应为了“看起来更安全”而改动：

- 没有发现签名、DocMDP、UR/UR3、XFA 或未知保护结构绕过。真实签名和未知保护仍会 fail closed。
- 没有发现 source hash、plan hash、state version 或审批 `WeakSet` 的跨计划复用绕过；SEC-02 是“同源重新加载”的会话身份缺失，不是 SHA-256 碰撞。
- 填表包明确标记 `authenticityVerified: false`，导入值会重新检查并复核；“包没有数字签名”本身不是当前的真实性误导漏洞。
- 没有发现可达的 React XSS sink。可控字符串通过 React 文本节点渲染；未发现把表单值送入 `dangerouslySetInnerHTML` 的路径。
- 没有发现 WebMCP 直接批准或导出工具。现有六个工具止于读取、暂存、验证和打开审核。
- Blob URL 是本地对象 URL，并有撤销路径；没有浏览器持久化表单值，也没有发现除演示 PDF 之外的业务数据网络发送路径。
- `untrustedContentHint: true`、closed JSON Schema、运行时解析和输出预算均已实现；这些控制有效，但不能替代本报告指出的会话身份、授权或 PDF 载荷策略。

## 3. 审计范围与威胁模型

### 3.1 WebMCP 表面

当前注册的工具为：

1. `get_pdf_protection`
2. `get_form_context`
3. `get_field_evidence`
4. `stage_form_values`
5. `validate_fill_plan`
6. `start_fill_review`

前三类读取工具可获得保护状态、字段结构，以及按需的源值/有效值；`stage_form_values` 修改暂存计划；后两个只验证或打开人工审核。没有 `approve`、`export`、`submit` 或上传工具。

### 3.2 攻击者能力

本轮按以下来源均不可信来审计：

- 用户或第三方提供的 PDF 字节，包括对象图、动作、附件、压缩流、表单字段名和值。
- PDF 内文字可能包含 prompt injection；它是数据，不是指令。
- 用户选择导入的填表包 JSON，包括 provenance、evidence 和大数组。
- 调用 WebMCP 的 agent，包括它声明的 provenance、置信度、证据和调用顺序。
- 延迟、重放、取消、并发或跨文档切换时仍在途的 WebMCP 调用。
- 可能同时拥有普通浏览器 DOM 操作能力的 agent；这个能力是否属于正式威胁模型由 TM-01 决定。
- 打开输出 PDF 的外部阅读器，其 JavaScript、附件或动作支持可能与 Chromium 不同。
- 可嵌套页面的恶意站点；是否成立取决于已认证部署响应头。

### 3.3 安全目标

- WebMCP 工具可以让 agent 检索、建议和暂存，但不得替用户作出破坏保护、批准或导出的决定；是否连普通 DOM 自动化也必须排除，由 TM-01 决定。
- 原 PDF 永不原地修改；输出策略必须与保护证据一致。
- 最终 `allowedMutations`/`exportStrategies` 必须是**保护策略与内容风险策略的交集**。`contentRisk` 只能移除能力，绝不能给签名、DocMDP、XFA 或未知保护新增能力；未知保护继续 inspection-only。
- 不把不确定的签名保留、内容净化或“人工在场”描述成已验证事实。
- 每个工具调用必须绑定到唯一文档会话和预期状态，不能跨重载重放。
- 对已证实存在放大或资源伤害的未受信任输入，在解析、状态、工具输出和 UI 渲染对应边界施加可验证预算；仅发现“没有配额”时先测量，不制造假修复。
- 敏感字段是否向 agent 暴露必须由明确、可撤销的产品策略决定。

## 4. 详细问题

### SEC-01 — 未受信任 PDF 活动内容与附件随输出保留

**严重度：High；可信度：High；优先级：P0。**

#### 证据

- `lib/pdf-engine.ts:3536-3558` 会计数 `JavaScript` 和 `URI`，但只有 `Launch`、`GoToR`、`GoToE`、`SubmitForm`、`ImportData` 和未知动作增加 `highRiskActionCount`。
- `lib/pdf-engine.ts:3598-3619` 只用 `highRiskActionCount === 0` 决定是否提供 `filled_pdf` 或普通衍生 PDF。
- `lib/pdf-engine.ts:4797-4806` 的最终导出拦截同样只看 `highRiskActionCount`。
- `tests/pdf-engine.test.ts:2202-2239` 明确断言 JavaScript、OpenAction、AA 和 URI 得到 `highRiskActionCount: 0`，并在 `applyApprovedValues` 后原样保留。
- `components/formproof-workbench.tsx:652-660` 为源 PDF 自动创建 Blob URL；`2154-2166` 通过 `<object type="application/pdf">` 显示。创建输出后也存在自动预览路径。
- 当前检查器没有覆盖从 `/EmbeddedFiles`、catalog/page `/AF`、`FileAttachment` 等入口可达的 FileSpec/附件，也没有覆盖 RichMedia、3D、Sound、Movie 等载荷。

独立安全复现创建了含 `invoice.exe` 附件的 AcroForm，填入 PII 后导出：

```json
{
  "sourceBytes": 1417,
  "activeContent": {
    "javascriptActionCount": 0,
    "additionalActionDictionaryCount": 0,
    "openActionCount": 0,
    "externalActionCount": 0,
    "highRiskActionCount": 0,
    "otherActionCount": 0
  },
  "exportStrategies": ["filled_pdf", "fill_package"],
  "outputBytes": 1822,
  "embeddedAttachmentPreserved": true,
  "verifiedValue": "PII value"
}
```

#### 为什么是真问题

FormProof 会把新的敏感值写入一个仍携带未验证行为或附件的容器。即使 Chromium 内置查看器不执行某种动作，收件人在 Acrobat 或其他阅读器打开输出时仍可能触发它。导出前的人工警告不能把未验证代码变成安全代码。

源文件和输出文件还会进入浏览器 `<object>` 预览路径，但本轮没有动态证明 Chromium 查看器会执行这些 fixture；因此预览只作为额外攻击面和 defense-in-depth 处理。High 的核心证据是危险结构获得了 PDF 导出许可并在写入新 PII 后被 round-trip 保留。

#### 最小安全修复

1. 按“入口/触发路径 + action 类型 + 可达载荷”分类，而不是看到某个 key 或 `FileSpec` 类型就拒绝：
   - 保持结构合法的内部 OpenAction destination、内部 GoTo 等已验证惰性导航可导出；`OpenAction` key 本身不是危险证据。
   - 可达 JavaScript（包括 name tree、OpenAction、AA、annotation/field/page action）、Launch、GoToR/GoToE、SubmitForm、ImportData、自动触发的外部动作和未知 action 一律移除 PDF 字节导出能力；只有保护层原本允许填表包时才保留 `fill_package`，未知保护仍然没有导出策略。
   - 只有从 `/EmbeddedFiles`、catalog/page `/AF`、FileAttachment、Launch/GoToE 等载荷入口可达的 FileSpec 才按附件处理；孤立或普通元数据中的 FileSpec 不能被误判。
   - 可达嵌入文件、associated file、FileAttachment、RichMedia、3D、Sound、Movie，以及无法安全分类的交互/内容入口，一律移除 PDF 字节导出能力；是否还能生成填表包仍由保护策略决定。
2. 单纯、需要用户主动点击的 URI link 是否阻断 PDF 导出是产品风险策略，不是本轮已证明的代码执行漏洞。第一版可以保守阻断，但必须返回独立的 `external_link_present` 原因、记录兼容影响，且不能把它描述成已执行脚本；若允许，则必须证明它不从 OpenAction/AA 自动触发且不会被 FormProof 注入动态值。
3. 报告明确的结构计数、触发方式和位置类别，但不要把原始脚本、URL 或附件内容返回给 agent。
4. 对被判定为危险的文件不创建原始 PDF `<object>` 自动预览。可以显示静态元数据和“预览已禁用”；若以后提供安全预览，应使用隔离、限额、不可交互的渲染管线。
5. 只有在实现结构化移除并用独立检查器确认输出为零活动/嵌入载荷后，才允许称为“净化副本”。第一轮修复不应承诺净化，直接降级为原 PDF 不动的填表包最稳妥。
6. 让 `protectionType` 继续描述签名/使用权；新增独立的 `contentRisk`/`payloadSummary`，不要把活动内容伪装成签名保护。

#### 验收测试

- 为 JavaScript name tree、JavaScript OpenAction、widget/field/page AA、URI link、URI OpenAction/AA、Launch、GoToR/GoToE、SubmitForm、ImportData 各建独立 fixture。
- 保留并强化现有合法 OpenAction destination 和共享内部 action fixture；它们必须仍可导出，不能因存在 `OpenAction` key 被误杀。
- 为 EmbeddedFiles name tree、catalog/page AF、FileAttachment annotation、RichMedia、3D、Sound、Movie 建 fixture；再加入一个不可从任何载荷入口到达的 FileSpec，证明不会按附件误判。
- 对保护层原本允许填表包的普通测试文档，可达 JavaScript、自动/外部高危动作、可达附件和无法分类的 active entry 必须得到：可检查、可暂存、`exportStrategies = ["fill_package"]`、不能创建 PDF 字节。相同载荷叠加未知保护时仍为 inspection-only，证明内容检查没有扩大权限。
- URI link 的 fixture 必须与 OpenAction/AA URI 分开，并按已记录的产品策略产生确定结果。
- 未知 action 必须 fail closed；未知 annotation 只有在属于未识别的交互/内容入口时才 fail closed，不把普通惰性 annotation 无证据地当作可执行代码。
- UI 回归确认危险源和任何危险输出都不挂载 `<object>`。
- 若未来加入净化策略：输出须由与写入路径独立的结构检查器重新打开，并证明所有上述计数为 0；任何解析不确定都拒绝。

#### 对五份官方表格的确定性兼容影响

`evals/real-pdf-corpus.json` 当前保存了五份表格的活动内容计数和预期 artifact。严格阻断可达 JavaScript 后，当前五份 corpus 都会只剩填表包。这是安全策略的预期结果，不得在实现时隐藏：

| 表格 | 当前活动内容计数 | 当前首选结果 | 严格阻断 JavaScript 后 |
| --- | --- | --- | --- |
| IRS 1040 | JS 3 | 填表包 | 填表包（不变） |
| IRS W-4 | JS 3 | 填表包 | 填表包（不变） |
| USCIS I-9 | JS 24、AA 32、URI 8 | 填好 PDF | **降级为填表包** |
| State DS-11 | JS 2、AA 2、OpenAction 1 | 填好 PDF | **降级为填表包**；先确认 OpenAction 是 destination 还是 action，不因 key 本身重复计罪 |
| VA 10-10EZ | JS 3、URI 5 | 填表包 | 填表包（不变） |

目标仍是 5/5 得到诚实且有用的结果，不是维持 I-9、DS-11 可写。除非以后能独立验证净化结果，否则不能为恢复兼容而放行 JavaScript。

### SEC-02 — 同源重载造成 WebMCP 会话 ABA

**严重度：Medium；可信度：High；优先级：P1。**

#### 证据

- `lib/form-state.ts:1121-1149` 中每次 `createFormState` 都从 `stateVersion = 0` 开始。
- `components/formproof-workbench.tsx:637-660` 每次加载都创建新 state。
- `components/formproof-workbench.tsx:166-184` 的调用绑定只比较 `expectedSourceHash` 和 `expectedStateVersion`。
- `lib/webmcp.ts` 的 version-bound schema 和游标没有 `documentSessionId` 或 load epoch。
- mutation lock 与文件加载不是同一个临界区；排队的旧 mutation 在拿到锁后才读取 `stateRef.current`，可能落到重载后的同字节文档。

重载完全相同的 PDF 时，旧会话和新会话都可以是同一个 SHA-256、同一个 version 0。旧请求因此不再是“stale”。这不需要哈希碰撞。

#### 最小安全修复

1. 每次成功加载生成新的、不可复用的 `documentSessionId`（例如 128-bit 随机 opaque ID）并保存到 FormState。
2. 所有状态相关工具响应返回它；所有字段读取游标、暂存、验证和启动审核调用都要求 `expectedDocumentSessionId`。
3. binding 比较顺序为 session ID、source hash、state version；错误代码区分 `document_session_mismatch` 与普通版本冲突。
4. load 开始时立即递增/替换 epoch，并取消旧 session 的在途工作；异步步骤在 await 前后都重查 epoch。
5. 文件切换与 plan mutation 使用同一个序列化/失效协议。不要让排队 mutation 在新文档上重新读取并执行。
6. 游标也绑定 session；换文档后旧 cursor 必须失败，而不是从新状态继续分页。
7. `documentSessionId` 是临时调用身份，只绑定工具调用、cursor、审批 UI 和在途任务；**不得进入 portable `planHash`**，也不得成为填表包跨重载导入的前提。填表包在 fresh FormState 导入并验证原有 source/plan 内容后，重新绑定当前 session。
8. 定义失败加载语义：建议用户一开始选择新文件就不可逆地关闭旧 session；解析期间新调用返回有界的 `document_loading`，解析失败后保持“无活动 WebMCP 文档”，直到用户显式重新加载。不要在失败后悄悄恢复可接受旧在途调用的 session。

#### 验收测试

- 相同 PDF A 载入两次：hash 和 version 相同、session 不同，旧暂存/验证/审核请求均失败且状态不变。
- A→B→A：第一次 A 的调用和游标不能命中第二次 A。
- 在 mutation 排队、解析中、visible commit 等待中触发 load；旧调用必须结算为明确的 abort/session mismatch，不能修改新 state。
- 不同 session 的错误响应不得泄露新文档字段值。
- 在 session A 导出的合法填表包可以导入同 source 的 fresh session B；两边 `planHash` 一致，但旧 session 的工具调用和审批记录仍失效。
- 新 PDF 解析失败时，旧在途调用仍失效；loading 和 failed 状态返回有界错误，不回退成隐式复活的旧 session。

### SEC-03 — 压缩流在预算前膨胀

**严重度：Medium；可信度：High；优先级：P1。**

#### 证据

- UI 仅在 `components/formproof-workbench.tsx:631-635` 限制输入文件为 15 MiB。
- `lib/pdf-engine.ts:3662-3668` 先执行 `PDFDocument.load(copyBytes(bytes))`。
- 对象图、XFA 等自定义预算在 `PDFDocument.load` 之后才执行。
- `pdf-lib` 的 decode stream 会扩容并完整解码部分流，因此小的压缩输入能在应用限额前造成大分配。

安全复现：约 33 KiB 的 PDF 携带一个由高重复字节压缩而成、解压后约 32 MiB 的 Flate stream，进程 RSS 增长约 78.8 MiB，之后才被对象流预算拒绝。执行修复前应把这个生成过程固化成确定性 test helper，并记录 compressed bytes、decoded bytes、filter chain 和流的可达入口，避免只保存一次 RSS 数字。

#### 最小安全修复

1. 在调用主线程 `PDFDocument.load` 前做原始字节 preflight：PDF header/EOF、对象与 stream 数、声明长度、filter 链深度、xref/object-stream 基本边界均有硬上限。
2. 所有不可信 PDF 解析迁到可终止 Worker；设置 wall-clock deadline、load epoch 和 abort。主 UI 不直接解析攻击者字节。
3. 对支持的压缩 filter 做“输出到上限即停止”的流式解码预算；累计解压字节、单 stream 解压字节和压缩比都受限。未知或不能限额的 filter 组合安全拒绝。
4. 若当前 `pdf-lib` 无法在所有 decode 路径中强制预算，必须选择以下之一：经用户批准引入可限额解析器/受控 fork，或对相关结构 fail closed。仅把解析放进 Worker 可改善响应性，但不能单独宣称内存 DoS 已修复。
5. 保留 15 MiB 原始输入上限；不要用提高该上限来掩盖兼容问题。

#### 验收测试

- 33 KiB→32 MiB fixture 在主线程 `PDFDocument.load` 前被拒绝，或只在可终止 Worker 内达到预算后停止。
- 分别覆盖普通 stream、object stream、XFA stream、嵌套 filter 链、虚假 `/Length`、多个小流累计膨胀。
- 拒绝后 UI 仍能响应、Worker 被回收、下一份正常 PDF 能加载。
- 五份官方 PDF 均在预算内；限额必须根据测量结果加合理余量，而不是为测试写特例。

### SEC-04 — Agent 可“洗白”provenance

**严重度：Low；可信度：High；优先级：P2。**

#### 证据

- `lib/webmcp.ts:283-325` 允许 agent 在 `user_instruction`、`source_document`、`agent_inference` 中自行选择 kind。
- `components/formproof-workbench.tsx` 把这个 kind 原样交给状态层。
- `lib/form-state.ts:818-879` 只禁止 agent 声称 `human_entry`；`user_instruction` 不需要可信指令 ID，`source_document` 只要求任意非空 evidence。
- `lib/form-state.ts:914-943` 只有 `agent_inference` 自动产生 inference review issue。
- UI 直接把 kind 格式化成人类可见标签。
- `lib/form-state.ts:1644-1655` 同时要求所有 draft 字段逐项确认；`components/formproof-workbench.tsx:1359-1382` 也要求所有 review field 被确认后才能继续。

复现中，agent 用伪造的 `user_instruction` 暂存任意值不会得到 inference issue；把相同值标成 `agent_inference` 则会得到。这说明一个不可信枚举正在影响风险说明和来源徽标。

**没有证据表明它绕过最终逐字段确认或批准 binding。** 当前影响是审核者可能被“user instruction”或“source document”标签误导，而不是 agent 获得直接批准能力，因此定为 Low。

#### 最小安全修复

1. 把“是谁提交的”与“它声称依据什么”分开。通过 WebMCP 进入的值统一属于 `agent_assertion` trust domain；agent 的 `claimedBasis` 只能用于解释，不能改变审核义务或显示为已验证来源。
2. 最小修复可以直接把三种 WebMCP kind 显示为“Agent 声称依据：…”，并让它们使用同一 review policy；不必先构建复杂的 instruction attestation 系统。
3. 如果产品以后确实需要 verified provenance：`user_instruction` 必须引用可信 UI 创建、session-bound 的 instruction record；`source_document` 必须由引擎绑定 source hash、session、locator 并独立核对。任意 evidence 文本不构成证明。
4. 保留所有 agent staged values 的人工逐字段审核；confidence 和 claimed kind 只能增加提示，不能取消提示。

#### 验收测试

- agent 自称 `user_instruction` 或 `source_document` 不能生成“已验证”徽标，也不能改变 required confirmation set。
- 若实现 verified provenance，假 instruction ID、旧 session ID、别的 source hash、伪造 locator 全部失败。
- 只有 UI 产生的真实 instruction record 和引擎验证的 source locator 才能进入 verified trust domain。
- WebMCP schema、运行时 parser、状态层和填表包 importer 使用同一 provenance 约束。

### SEC-05 — 恶意填表包 evidence 可耗尽前端资源

**严重度：Medium；可信度：High；优先级：P1。**

#### 证据

- `lib/form-state.ts:28` 只限制整个包为 4 MiB。
- `lib/form-state.ts:818-832` 只验证 evidence 是非空字符串数组，不限制项数、单项长度或总 UTF-8 字节。
- `lib/form-state.ts:2247-2276` 在导入时把完整数组复制进状态。
- `components/formproof-workbench.tsx:2711-2717` 对全部 evidence 执行 `.map()`，每项创建一个 `<li>`。
- WebMCP 输入路径已经有 `5` 项、每项 `500` 字符、rationale `500` 字符的边界，但填表包 importer 没有复用。

复现结果：

```json
{
  "evidenceItems": 200000,
  "packageBytes": 3409178,
  "importAccepted": true,
  "renderedLiCountByUi": 200000
}
```

#### 最小安全修复

1. 抽出并复用同一 provenance 边界：evidence 最多 5 项、每项最多 500 字符且去重；rationale 最多 500 字符。
2. 再增加跨字段累计的 evidence/provenance 条目数与 UTF-8 字节预算，避免用多字段绕过单项上限。字段值和完整 staged plan 的总预算不属于 SEC-05，继续按 HARD-01 先测量再决定。
3. 在 clone、hash 和 React state 写入之前验证；失败必须原子化，现有 state 不变。
4. UI 仍做防御性 `slice(0, 5)` 并显示省略数量，防止未来状态层回归直接冻结页面。
5. JSON 深度和对象键数目前没有独立伤害复现；先保留为 defense-in-depth 候选，只有在补出解析/clone 资源证据后再增加对应限制。不要把它计入 SEC-05 的完成条件。

#### 验收测试

- 5×500 evidence 接受；6 项、501 字符、重复项和超过总字节预算均以 `invalid_provenance` 拒绝。
- 200,000 项复现包在进入 React state 前拒绝，审核 UI 不创建大列表。
- importer、WebMCP parser 和直接状态 API 的边界一致。

### SEC-06 — `start_fill_review` 重放会重置人工状态

**严重度：Low；可信度：High；优先级：P2。**

`components/formproof-workbench.tsx:1016-1061` 每次合法调用都会进入 `openReview()`；`openReview` 会重建默认导出策略、确认集合和 acknowledgment。关闭审核本身不递增 state version。因此 agent 可对同一 binding 重放，清掉用户已作出的选择或在用户取消后重新打开，造成困扰并增加误操作概率。

修复要求：

- 对同一 `documentSessionId + sourceHash + planHash + stateVersion` 的 `start_fill_review` 做幂等处理；如果已经打开，仅返回当前状态，不重置任何选择。
- 用户关闭后记录该 binding 的 dismissal；同一 binding 不能由 agent 再打开，只有新的 plan/version 或明确 UI 操作可以。
- 不预选破坏保护或创建 PDF 的策略；策略选择始终属于当前人工审核会话。

验收：重复 100 次调用都不改变确认、ack、策略或 dismissal；计划改变后才创建新的审核 binding。

### SEC-07 — 工具注册生命周期存在取消窗口

**严重度：Low；可信度：High；优先级：P2。**

`lib/webmcp.ts:1823-1880` 在顺序等待所有 `registerTool` 后才返回包含 `cleanup` 的 registration；`components/formproof-workbench.tsx:1065-1106` 在 Promise 结算前拿不到它。如果某次注册挂起并且组件卸载，已注册工具仍可能保持可调用，内部 controller 也没有被取消。

修复要求：让调用方在开始注册前就拥有 AbortController。推荐 API 同步返回 `{ signal, cleanup, ready }`，或接收调用方创建的 `AbortSignal`；每个顺序注册都使用同一 signal，unmount 立即 abort，迟到的完成不得更新 UI。

验收：让第 N 个 `registerTool` 永不结算，随后 unmount；此前注册工具收到 abort，后续工具不注册，Promise/ready 能以已知状态结束。

### SEC-08 — visible commit barrier 可无限等待

**严重度：Low；可信度：High；优先级：P2。**

`components/formproof-workbench.tsx:203-206` 使用两个 `requestAnimationFrame`，没有 abort 或 timeout。`lib/webmcp.ts:2003-2036` 在每个工具结果之后——包括读取和失败——都等待这个 barrier，并只在等待后再次检查 abort。隐藏 tab 中 RAF 可被长期暂停，所以取消的调用仍可能不结算。

修复要求：

- 只对成功且确实改变 UI revision 的 mutation 等待 visible commit。
- 用 layout-effect/commit revision acknowledgment 代替无归属的双 RAF，并与调用 abort、document visibility 和有界 timeout 竞争。
- timeout 后返回明确的 `ui_commit_unconfirmed` 与当前 revision；不能让客户端通过盲重试重复 mutation。

验收：隐藏页面、abort、失败的 read、成功 mutation、commit timeout 均在有界时间内结算；读取工具不等待渲染帧。

### ROB-01 — 填表包导出/导入大小不对称

**分类：Low 正确性/互操作缺陷；可信度：High；优先级：P2。**

`lib/form-state.ts:1952-2008` 导出时没有检查最终序列化字节数；`2047-2051` 导入时拒绝超过 4 MiB。复现中，一个约 20,950 字节的源 PDF、55 个各约 80,000 字符的值生成 4,427,623 字节包，导出成功但立即导回得到 `package_too_large`。

修复要求：导出成功的包必须使用与 importer 完全相同的 UTF-8 字节预算；超过上限时不创建下载并返回 `package_too_large`。之后可通过去除可从源 PDF 重新派生的冗余数据来压缩格式，但不能静默截断值或 provenance。

验收：在有 draft 的 state 导出成功后，用相同 source 重新检查并创建无 draft 的 fresh FormState，再导入该包；同 schema 版本必须成功。当前 importer 正确拒绝把包合并进已有 draft，因此不能把“立即导回原 state”写成断言。边界覆盖上限减一、等于上限、上限加一及多字节 Unicode。

### HARD-01 — 暂存计划累计预算候选尚未证明为 DoS

**分类：待验证 hardening；“缺少总预算”的可信度 High；安全影响未证明。**

WebMCP 单次最多 25 个更新，字符串值最多 4,000 字符，但 agent 可以重复调用，在一个文档会话中累计大量字段和值。当前状态会完整 clone、hash、验证和渲染 draft。复现可在 100 个字段中累计约 400,000 字符而被接受；这只证明“没有累计总预算”，尚未证明冻结、OOM 或不可接受延迟。

先验证，再决定是否修：

- 用真实浏览器分别测量 100、500、1,000 字段和递增序列化字节下的 staging、clone、plan hash、validation、review render 时间、峰值 heap 和页面响应性。
- 先记录支持浏览器的安全/UX 阈值，以及五份官方表格的基线和合理余量；不要事后按测试结果移动门槛。
- 只有当 agent 可在现有输入边界内造成超过阈值的阻塞或内存增长时，才升级为安全 finding，并对每个 document session 施加 staged field 数、序列化 UTF-8 字节、provenance 字节总预算。
- 若需要限额，每次 mutation 在临时副本上计算“变更后总量”，超限时整批原子拒绝；`get_form_context` 只返回粗粒度剩余预算。
- 若测量未显示实质影响，记录结果并不改代码；不要为了拥有一个配额而制造官方表单兼容问题。

若问题被证实，验收为：多次小调用不能绕过总量限制；批次中任一项使总量超限时整个 state/version/planHash 均不变；五份官方表格不受影响。若未证实，完成物是可复现测量与“不修”的明确结论。

## 5. 条件性风险与必须先做的产品决策

### TM-01 — “UI-only”不等于可证明的人类在场

当前实现正确地没有 WebMCP `approve` 或 `export` 工具，并把字段确认、导出策略、Reader Extensions 损失确认和最终创建动作放在普通 React 控件中。这能建立“WebMCP 工具层不可直接批准”的边界。

但如果威胁模型允许同一个 agent 使用浏览器自动化点击 DOM，这些普通控件仍可被操作。`event.isTrusted`、瞬时 user activation、延时或鼠标轨迹都不能可靠证明是人；不要把它们实现成安全修复。

执行前必须选择并记录以下一种定义：

1. **推荐的诚实边界**：产品只声称“批准/导出未暴露为 WebMCP 工具，必须通过可见审核 UI 完成”；浏览器级自动化在这一声明之外。UI 仍做反 framing、防重放和清晰确认。
2. **更强的重新认证/设备在场边界**：WebAuthn user verification 可以作为重新认证或本地设备在场信号，并把 challenge 绑定到 `documentSessionId + sourceHash + planHash + stateVersion + exportStrategy`；但它还需要 RP、credential enrollment 和验证端，而且**不能证明用户阅读、理解或逐字段批准了计划**。只有能向用户呈现并由可信平台确认具体事务内容的端到端机制，才可能支持更强声明；否则仍须收窄产品文案。

不要选择第三种“用 DOM 事件特征假装证明人类”的方案，也不要把单独的 WebAuthn user verification 描述成语义审核证明。

### PRIV-01 — 是否需要每文档 WebMCP 数据共享授权

行为已确认：组件 mount 后自动注册工具；加载 1040、W-4、VA 表单后，`get_field_evidence` 可以返回字段的 `sourceValue` 和 `effectiveValue`。这些可能是 SSN、地址、健康和财务信息。`untrustedContentHint` 告诉客户端内容不可信，但不是用户对披露敏感数据的授权。

对税务/医疗表格，建议产品决定为：

- 默认关闭“允许 agent 读取此 PDF”；
- 仅非敏感保护元数据可在未授权时返回，字段名/值按策略 redacted；
- 用户在 UI 对当前 `documentSessionId` 明确开启，必要时限定字段范围；
- 换文档、卸载或用户撤销时立即失效，不持久化到下一会话；
- agent 不能通过工具调用替用户开启；工具返回 `consent_required` 而不是诱导 agent 猜值。

如果产品明确把“用户把 PDF 加载到一个 agent 原生工作台”视为披露授权，也必须把该假设写进 UI、隐私说明和威胁模型，不能继续隐含处理。

### DEPLOY-01 — 反 framing 与部署响应头尚未闭环

审批 UI 是安全边界，因此点击劫持值得防御。仓库的 `dist/client/_headers` 当前只有静态资源 immutable cache 规则，未看到反 framing 的核心配置：

- `Content-Security-Policy: frame-ancestors 'none'`
- `X-Frame-Options: DENY`（兼容防线）

`base-uri 'none'`、`X-Content-Type-Options: nosniff` 和明确的 `Referrer-Policy` 是合理 deployment hardening，但本轮没有为它们建立独立攻击路径，不能计作 DEPLOY-01 的完成证据。

`tools` Permissions Policy 的默认 allowlist 已经是 `self`，且当前 `registerTool` 没有设置 `exposedTo`；因此没有显式 `Permissions-Policy: tools=(self)` **不是漏洞**。可以把该 header 加作配置可读性和 defense-in-depth，但不能计作 DEPLOY-01 的修复证据，也不要为了它宣称发现了跨源工具暴露。

对私有预览的未认证请求只得到认证层 401；它有 `Cache-Control: no-store` 和 `Referrer-Policy: no-referrer`，但不能据此证明已认证应用页面的 header。因此这项不能标成“线上已可点击劫持”，也不能标成“线上已安全”。

执行顺序必须是先在**已认证的 HTML 响应**上检查 `frame-ancestors`/X-Frame-Options 和真实 iframe 行为：若托管平台已经注入有效防线，记录证据且不改代码；只有缺失时才在平台支持的位置配置并回归。若扩展成完整 CSP，需要按实际构建生成 nonce/hash；若保留 PDF Blob 预览或加入 Worker，精确允许所需 `object-src blob:`/`worker-src blob:`，不要用宽泛 `unsafe-inline` 或 `*`。

验收：恶意跨源 iframe 无法加载审核页；同源应用、必要 Worker 和安全 PDF 预览仍工作；实际私有 URL 的已认证主文档响应包含期望头。

## 6. 已验证的现有控制

以下控制有真实价值，修复时必须保留：

- 所有工具使用 closed schema，并在运行时再次解析，不信任宿主只做 schema 校验。
- 工具名集合固定，`readOnlyHint` 与实际行为一致，所有工具都有 `untrustedContentHint: true`。
- 工具描述和结构化输出已有字节/数组预算；读取证据使用按字段、按需接口，而不是一次返回整份文档。
- Agent actor 不能覆盖 human-pinned field，也不能声明 `human_entry`。
- mutation 有串行锁，并在异步后重查部分 state；SEC-02 是需要补 session identity 和 load 失效，不应删掉现有锁。
- 批准记录绑定 source hash、plan hash、state version，并使用内部 trusted record；没有发现伪造或旧计划批准复用。
- WebMCP 没有批准、导出或提交工具；导出策略选择标记为 `human_ui_only`。
- Reader Extensions 只在明确人工确认后生成普通衍生副本；原 PDF 不改，且不声称 CMS/签名仍有效。
- 真实签名、禁止修改的 DocMDP、XFA 与未知保护结构保持安全拒绝或仅填表包策略。
- PDF 输出会重新打开并验证 source binding、目标字段值、widget/appearance 基本条件；这不是像素级视觉验证，但比“save 成功即完成”更强。
- 填表包绑定 source hash 和 plan hash，导入后重新检查字段约束；UI 明确不声称包真实性已验证。
- React 文本转义、Blob URL 撤销和无持久化存储路径降低了普通 XSS 与残留数据风险。

## 7. 给 GPT-5.6 Sol High 的执行计划

下面的顺序以“先降低实际伤害，再修身份/资源边界，最后收口生命周期”为原则。每一阶段都应形成小而可审查的提交；不要把所有安全变化混在一次重构中。

### Phase 0 — 固定基线和三项决策（不改行为）

1. 读取 HEAD、当前未提交 diff、本文和五份官方 PDF corpus；保留用户已有修改。
2. 运行并记录：`pnpm test`、`pnpm typecheck`、`pnpm lint:project`、`pnpm format:check`、`pnpm build`、`pnpm eval:verify`。任何既有失败与新失败分开记录，禁止删/弱化测试。
3. 写入现有设计文档或代码内已有合适位置，不要新建无要求的文档：
   - TM-01 采用“WebMCP-only 边界”还是更强的事务确认边界；推荐前者并精确收窄文案，除非产品能提供可验证的端到端事务确认。单独 WebAuthn user verification 不足以证明语义审核。
   - PRIV-01 在“默认关闭、每文档显式授权”和“加载即授权但明确披露”中选择；本报告推荐前者，但执行者不得跳过决策直接假定产品政策。
   - 活动/嵌入载荷采用按可达触发路径分类的 fail-closed 策略；JavaScript 和可达附件移除 PDF 字节导出能力，只有保护层原本允许时才保留 fill package；合法内部 destination 不退化，URI link 另行记录政策。
4. 为每个后续 finding 先添加能失败的最小复现测试，证明问题存在后再改实现。

**Phase 0 停止条件：** 若威胁模型要求证明用户理解并批准了具体计划，但团队没有可验证的端到端事务确认机制，则不得继续使用“agent 不能代替人批准/导出”的强声明；先改产品声明。平台介导或 WebAuthn 重新认证本身不自动满足这个条件。

### Phase 1 — P0：封堵危险 PDF 载荷与预览

责任范围：`lib/pdf-engine.ts`、相关 PDF engine tests、Workbench 预览/审核 UI、WebMCP protection 输出和 eval fixture。

1. 建立按入口、触发路径和 action/载荷类型分类的 `contentRisk`/`payloadSummary`，覆盖 SEC-01 fixture 矩阵；不是按计数非零一刀切。
2. 先计算保护层能力，再用内容风险层只做削减：可达 JavaScript、自动/外部高危动作、可达附件和无法分类的 active entry 移除所有 PDF 字节导出策略；只有保护层本来允许时才保留 staging/fill package。未知保护继续 inspection-only。合法内部 OpenAction destination/GoTo 不退化，URI link 按 Phase 0 记录的策略处理。
3. 禁用危险源的 `<object>` 自动预览，显示明确的“原 PDF 未修改；由于活动/嵌入内容，不生成填好 PDF”。
4. WebMCP 返回明确、紧凑且不泄露载荷内容的 `contentRisk`、`allowedMutations`、`exportStrategies` 和原因码。
5. 更新五份真实 PDF benchmark。严格阻断 JavaScript 的预期是 5/5 只剩填表包；I-9 和 DS-11 从 filled PDF 确定性降级，必须在 benchmark、UI 和发布说明中如实呈现。

**不要在这一阶段实现无法独立验证的 sanitizer。** 如果实现路径只是删除已知 key，它仍是黑名单，不满足完成条件。

### Phase 2 — P1：会话身份与隐私策略

责任范围：`lib/form-state.ts`、`lib/webmcp.ts`、Workbench adapter/UI、WebMCP tests/evals、fill-package schema/migration strategy。

1. 按 SEC-02 加 `documentSessionId` 与 load epoch，覆盖所有绑定、游标和异步重查；session ID 不进入 portable plan hash，合法 package 导入 fresh state 后重新绑定当前 session。
2. 按 Phase 0 的 PRIV-01 选择执行条件分支：
   - 若选择显式授权：每文档默认关闭；UI 授权、撤销、换文档失效；未授权值输出 redacted/`consent_required`。
   - 若选择加载即授权：保留值读取行为，但在加载 UI 和隐私说明中明确披露，定义换文档、卸载和用户撤销语义，并加入对应测试。
3. 更新 WebMCP schema、运行时 parser、adapter result、tool descriptions 和 eval catalog；工具描述保持简短，明确 PDF 内容不可信。
4. 对跨 session、旧 cursor、旧 package，以及所选 consent 模型下的撤销/换文档在途调用写对抗测试。

**兼容原则：** 协议字段变化如需版本号，应明确 bump；不要接受缺失 session ID 的 mutation 作为兼容 fallback。

### Phase 3 — P1：解析和输入资源预算

责任范围：PDF worker/preflight、`lib/pdf-engine.ts`、`lib/form-state.ts` importer、Workbench 渲染、资源攻击 fixtures。

1. 先完成 SEC-03 技术 spike：证明能在所有 relevant decode path 上强制累计输出预算。不能证明时停下并报告需要受控 fork/新依赖的具体原因和版本，不得声称已修。
2. 将不可信 PDF 检查移入可终止 Worker，并实现原始字节、stream/filter、解压累计、时间和 epoch 限额。
3. 按 SEC-05 统一 provenance 限额，并在 React state 前拒绝；UI 加防御性截断。
4. 对 HARD-01 先做浏览器 heap/耗时/响应性测量；只有证实超过预先记录的阈值才加 per-session 累计计划预算，否则记录“不修”。
5. 已确认的超限失败必须是原子的、结构化的，且不回显大输入。

### Phase 4 — P2：审核和生命周期收口

责任范围：Workbench review state、WebMCP registration/executor、fill-package export。

1. 按 SEC-06 使 review start 幂等并记录 dismissal binding。
2. 按 SEC-07 改为调用方先持有 cancellation，测试半注册卸载。
3. 按 SEC-08 只等待成功 mutation 的 commit revision；等待可 abort、有 timeout。
4. 按 SEC-04 把 agent claims 与 trusted provenance 分开；旧包中的 agent kind 降级为 unverified claim，不能自动提升信任。
5. 按 ROB-01 统一导入/导出最大序列化字节，并用 fresh FormState 做 round-trip 属性测试。
6. 若采用 TM-01 更强边界，先证明平台能确认绑定的具体事务内容；WebAuthn user verification 只能作为重新认证组件。否则只调整精确声明，不做伪安全机制。

### Phase 5 — 部署防线和完整回归

1. 先验证已认证私有 HTML 响应和跨源 iframe。只有确认缺少有效 `frame-ancestors`/X-Frame-Options 时才配置 DEPLOY-01 headers，再在本地/预览验证 CSP 不破坏运行；若平台已注入，则保存证据且不做代码修改。
2. 跑完整验证矩阵：
   - `pnpm test`
   - `pnpm typecheck`
   - `pnpm lint:project`
   - `pnpm format:check`
   - `pnpm build`
   - `pnpm eval:verify`
   - 五份官方 PDF benchmark 与真实 round-trip/data-package 验证
   - 浏览器回归：授权、撤销、同源重载、旧请求、危险预览、review replay、导出三种结果、framing
3. 重新测量安全性、准确性、效率、token 节省和兼容性。成功标准仍是“5/5 都得到诚实且有用的结果”，不是“5/5 都能修改 PDF”。
4. 在私有预览部署后做已认证 header 和核心路径 smoke test；保持仓库私有，不在此计划中公开。

## 8. 提交拆分建议

建议按以下依赖顺序，每项独立提交并附测试：

1. `Block active and embedded PDF payload exports`
2. `Bind WebMCP calls to document sessions`
3. `Bound PDF decoding in a terminable worker`
4. `Bound imported provenance evidence`
5. `Apply the chosen per-document data consent policy`
6. `Separate agent claims from trusted provenance`
7. `Make human review replay-safe`
8. `Make WebMCP lifecycle waits abortable`
9. `Enforce fill-package round-trip size symmetry`
10. `Verify and conditionally harden authenticated framing headers`
11. `Re-run official PDF and browser security evals`

HARD-01 只有在测量证实资源伤害后才增加单独提交 `Bound cumulative staged-plan resources`；未证实时不得为了匹配此列表而创建该提交。任何新增依赖或受控 fork 都必须先向用户说明包名、精确版本和现有方案为何不足并获得许可。

每次提交前：重读完整 diff，精确 stage 文件，扫描 secrets，不修改用户无关文件，不使用 `git add .`/`git add -A`，不跳过 hooks。

## 9. 完成定义与验证矩阵

| 风险 | 必须出现的失败前测试 | 修复后不可妥协的断言 |
| --- | --- | --- |
| SEC-01 | JS/可达附件仍得到 PDF export | 内容风险只削减保护层能力；普通文档降为 fill package、未知保护仍 inspection-only；合法内部 destination 不误杀；URI 按记录策略 |
| SEC-02 | 同 PDF 重载后旧 mutation 被接受 | session/epoch 不同即拒绝，state 不变 |
| SEC-03 | 小压缩输入使主线程大解码 | 有界解码/可终止，拒绝后 UI 可用 |
| SEC-04 | agent claim 被显示成可信来源 | agent 声明不改变 trust、确认集合或“已验证”标签 |
| SEC-05 | 200k evidence 包成功导入 | 在 state/render 前拒绝，错误有界 |
| SEC-06 | 同 binding 重放清空确认 | 幂等，dismissal 不可由 agent 重开 |
| SEC-07 | 半注册 unmount 后工具仍 active | 调用方立即 abort，迟到注册不可用 |
| SEC-08 | hidden tab + abort 永不结算 | 所有路径有界结算，read 不等 UI commit |
| ROB-01 | export success 但 fresh-state import fail | 所有成功导出都能在同 schema、同 source 的 fresh state 导入 |
| HARD-01 | 仅证明没有总预算 | 先测量；证实才原子限额，未证实则不改代码 |
| PRIV-01 | 当前未设文档级授权 | 显式授权则默认 redacted；加载即授权则明确披露并验证撤销/换文档语义 |
| DEPLOY-01 | 已认证跨源 iframe 可呈现审核页 | 先验证；若缺失则修到主文档被 `frame-ancestors`/XFO 拒绝，若平台已有则不改代码 |

修复不得通过以下方式“让测试变绿”：

- 不得删除、skip、弱化或为 fixture ID 特判。
- 不得把 `/Perms` 一概称为“已签名”。
- 不得打开受签名/DocMDP 保护 PDF 的普通重写路径。
- 不得声称 `pdf-lib` 保留了签名；当前没有可独立验证的增量签名保留能力。
- 不得把 source hash/plan hash 描述为内容真实性或签名证明。
- 不得用 `event.isTrusted`、user activation 或 DOM 延时冒充人类在场证明。
- 不得把“已删除几个已知 key”描述为完整 PDF sanitizer。
- 不得为了提高 5/5 可写率弱化 XFA、未知保护或未知载荷的 fail-closed。

## 10. 五份官方 PDF 的回归要求

固定 corpus：

- IRS Form 1040（2 页）
- IRS Form W-4（5 页）
- USCIS Form I-9（4 页）
- U.S. State Department DS-11（6 页）
- VA Form 10-10EZ（6 页）

每份都必须记录：

- 保护证据：真实 signature/ByteRange、DocMDP `/P`、UR/UR3、Reader Extensions、XFA、未知结构。
- 内容风险：actions、OpenAction/AA、JavaScript、URI、附件/associated files、富媒体和未知项。
- `protectionType`、`allowedMutations`、`exportStrategies`、`signatureImpact`、`requiresHumanConfirmation`。
- Agent 能否获取字段上下文、能否暂存、能否生成 filled PDF/confirmed derivative/fill package。
- 数据 round-trip：源 hash、plan hash、值、字段约束、导入结果和输出重新检查。
- 准确性、耗时、峰值内存、工具调用数、输入/输出 token 估算。
- 失败必须保留真实 error code 和原因；不能把“只生成填表包”计为兼容失败，也不能把它伪装成 PDF 已填好。

## 11. 剩余硬限制

即使本计划全部完成，仍应公开保留这些限制：

- 不能用当前 `pdf-lib` 对受签名/认证 PDF 做可验证的增量写入，也不声称保存签名有效性。
- CMS 完整性、证书链、撤销状态和签署者身份未由浏览器应用验证。
- PDF 输出的字段值、widget 和 appearance 检查不是像素级渲染等价证明。
- PDF 规范的活动内容面很大；任何无法安全分类的可执行、交互或嵌入入口必须继续 fail closed，同时不要把已验证惰性的内部 destination/annotation 误报为代码。
- Worker 和时间预算降低资源风险，但除非所有 decode 路径都有硬字节上限，不能宣称彻底消除内存 DoS。
- 填表包证明与 source/plan 相匹配，不证明创建者身份或内容真实性。
- 若采用 WebMCP-only 人工边界，具备普通浏览器自动化能力的 agent 仍可能点击 UI；文案必须如实说明。
- 托管平台、浏览器和 PDF viewer 行为会变化，部署 header 和 viewer 行为需要持续回归。

## 12. 依据与未覆盖项

本报告参考当前官方资料：

- [WebMCP draft specification](https://webmachinelearning.github.io/webmcp/)
- [Chrome WebMCP tool security guidance](https://developer.chrome.com/docs/ai/webmcp/secure-tools)
- [Chrome imperative API guidance](https://developer.chrome.com/docs/ai/webmcp/imperative-api)

这些资料支持的关键原则是：工具应最小权限、准确标注只读/不可信内容、控制输出大小，并谨慎暴露用户信息；跨源工具暴露需要显式策略。`untrustedContentHint` 是风险信号，不是保密、授权或人类在场边界。

本轮未把以下内容当作已验证结论：

- 未认证 401 响应不能代表已认证私有应用的全部安全头。
- 没有依赖外部漏洞数据库结果来给依赖项下结论；依赖 CVE 扫描应在执行阶段于获准联网环境重新跑并保存结果。
- 没有对所有第三方 PDF viewer 的脚本执行行为做动态攻击；SEC-01 的核心结论是结构被保留并获得了输出许可，这一点已由 round-trip 复现确认。

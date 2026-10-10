# Zelnum n8n 工作流模板

两套可直接导入的模板。本地文件与模拟验证已完成（见第 5 节），**尚未在真实 n8n 实例中导入并做端到端验收**。

| 模板 | 可导入文件 | 使用场景 |
| --- | --- | --- |
| Realtime | `zelnum-realtime.n8n.json` | 单个手机号或邮箱，选择 1–10 个同系列产品，报价后检查并输出逐产品判定 |
| Bulk | `zelnum-bulk.n8n.json` | 联系人列表，规范格式、可选去重、报价、提交、限次轮询、恢复已有任务、下载 ZIP/CSV |

只使用内置节点：Manual Trigger v1、Edit Fields v3.4、HTTP Request v4.2、Code v2、If v2.2、Sticky Note v1；Bulk 另外使用 Wait v1.1。没有社区节点、npm 安装要求或外部代码依赖。请在具有这些节点版本的当前 n8n 实例中导入测试。

## 1. 注册与凭据

1. 在 [app.zelnum.com](https://app.zelnum.com) 注册/登录，进入 **API Center** 创建 API Key。收费检查需要足够余额。
2. 在 n8n 创建一个 **Header Auth** 凭据：
   - Name：`X-API-Key`
   - Value：你的私有 API Key。
3. 在 HTTP Request 节点中选择该凭据：
   - Realtime：quote、BILLABLE check 两个节点。
   - Bulk：quote、BILLABLE submit、status、metadata、download 五个节点。
   - `Get current product catalog` 是公开接口，不需要凭据。

API Key 不填到 Edit Fields、HTTP Header 参数、Code、Sticky Note 或模板说明中。发布文件没有任何凭据 ID、密钥、真实联系人、执行缓存或个人实例 ID。自己的凭据只在自己的 n8n 中绑定。

官网：[Zelnum](https://zelnum.com)；完整 API 参考：[docs.zelnum.com](https://docs.zelnum.com)。

## 2. 导入

在自己的 n8n 新建工作流，使用菜单 **Import from File** 导入对应 JSON。先阅读左侧黄色说明和下面的凭据说明，再填配置。模板没有自动计划任务或公开 Webhook；默认不会创建付费检测。

### Realtime 配置

在 **Configure realtime request** 节点统一设置：

| 字段 | 填写说明 |
| --- | --- |
| `series` | `phone` 或 `email` |
| `identifier` | 自己有权处理的一个真实联系人；模板默认留空 |
| `country` | Phone 的两字母国家代码；完整 E.164 可以留空；email 自动不发送 |
| `product_ids` | 1–10 个不同的整数 ID，且都是当前 realtime、同 series 产品；默认空数组 |
| `idempotency_key` | 每个逻辑请求独立且稳定的 ASCII 请求键，最长 191 字符 |
| `execute_billable` | Boolean；默认 `false`，只走报价预览 |
| `max_total_usdt` | Number；你接受的最高报价金额，默认 `0` |

读取 [当前 Realtime 产品](https://docs.zelnum.com/realtime-products/)，也可检查公共 catalog 节点输出；不要把 bulk slug 当作 realtime ID。

1. 保持 `execute_billable=false`，执行整个流程，查看 **Return quote preview — no charge**。
2. 确认成本，设置金额上限和 `execute_billable=true`，再次执行整个流程。
3. 收费执行会重新获取报价，检查期限/金额，并原样发送该次报价的请求体，而不是复用第一次预览的旧 token。
4. **Prepare product verdicts for CRM** 输出 `results`、`status`、费用、`verification_state`：
   - `all_valid`：选中的产品都有有效且明确的判定。
   - `all_invalid`：选中的产品都明确判为 invalid。
   - `mixed_verdicts`：产品之间有 valid/invalid 差异。
   - `manual_review`：存在 unknown、退款、错误或未解决结果；不要当成 invalid。

产品的 `valid` 并不自动表示联系人授权、身份所有权、营销许可或所有邮箱服务都能投递。按自己的业务策略决定 CRM 分流，不能只看 HTTP 200。

### Bulk 配置

在 **Configure bulk request** 节点统一设置：

| 字段 | 填写说明 |
| --- | --- |
| `series`、`country` | Phone 国家代码必填；email 自动省略 country |
| `product` | 当前 async 产品 slug，不是 realtime 数字 ID |
| `identifiers` | 逗号/换行分隔的真实联系人列表；也可将字段改为 Array 类型并提供 string 数组 |
| `deduplicate` | Boolean；默认 `true`，按规范化后的字符串去重并报告数量 |
| `idempotency_key` | 这一批次的独立请求键；同一批次重试要保持不变 |
| `execute_billable`、`max_total_usdt` | 与 realtime 一样，默认关闭收费 |
| `resume_task_id` | 留空创建新任务；填写已有 task ID 则只查状态/下载，跳过报价与提交 |
| `max_poll_attempts` | 默认 120；允许 1–360 |
| `poll_interval_seconds` | 默认 5；允许 3、4、5 秒 |

读取 [当前 Bulk 产品](https://docs.zelnum.com/async-detection/products/)：实时查询 catalog 的 `min_phones`，在去重后检查最低数量。不能用两个示例号码测试正式批次，也不能填假联系人凑数量。本模板的报价数组接口最多 **10,000 输入行**；更大列表分批，或另行按 [文件提交 API](https://docs.zelnum.com/async-detection/submit-file/) 开发。

1. 先执行报价预览，查看输入行数、实际提交数、去重数和费用。
2. 明确设置上限并开启收费后执行整个流程。
3. 立即保存 **Store returned task ID** 的 `task_id`；模板默认不保存执行历史。
4. 每次只轮询一个任务，不会创建 120 个并行任务。遇到 pending/processing 才等待下一次查询。
5. 轮询次数达到上限会输出 `poll_limit_reached` 和 task ID，不会取消远程任务，也不会自动重新收费提交。
6. 需要继续时填 `resume_task_id` 再执行；这个分支始终只读，即使收费开关为 true 也不会再次提交。
7. 正常结果在 **Reject failed or empty download** 输出 **binary.data**；在 n8n 查看/下载文件，或在该节点之后接自己的存储节点。

模板没有显式本地文件写入节点；HTTP 文件先进入 n8n 的二进制存储，其磁盘/S3/内存策略由实例控制。最终输出要求 HTTP 200、非空文件，以及 ZIP 头或合理的 CSV 内容/媒体类型；它不负责检查 ZIP 中每条数据的真实性或完整解压验证。大文件会占用内存，超出实例容量时使用流式下载客户端。

## 3. 超时、失败、重试与隐私

- 报价按返回的 `expires_at` 失效；收费前再次检查。请求金额高于上限会在本地停止。
- 更换联系人、产品、series 或国家时视为新逻辑请求。未知结果/网络超时重试要保持原输入和原 idempotency key；不要为了“重试”生成新键。Realtime 和 Bulk 用不同键。
- HTTP 节点关闭自动重试。401/403 检查凭据或权限；402 检查余额；409/429/500/503 按文档处理，不盲目重新提交。
- Bulk 的 `failed` 输出为 `task_failed`；completed 且不可下载输出为 `completed_result_unavailable` 或 `completed_result_expired`，不会误判为 processing。
- 404 可能是过期、不存在或没有访问权限，不能只凭 404 判定任务尚未完成；422 的 `result_not_ready` 另行处理。结果须在 API 返回的有效期内下载。
- 下载仅接受该任务在 `api.zelnum.com` 的精确路径，且关闭重定向，避免把密钥发到外部地址。
- 每次轮询间隔之外还有网络耗时；默认 120 次不是精确的 10 分钟承诺。模板最长执行时间设置为 30 分钟，n8n Cloud 套餐/管理员还可能施加更短限制。
- 模板关闭成功、失败、手动执行的保存和节点进度保存。运行中的界面、凭据库、二进制存储及实例日志仍可能包含私有数据；不要误以为这是完全无痕执行。
- 只处理你有合法依据处理的联系人。不要在公开模板中 pin 数据，不要上传带真实列表或凭据引用的个人导出。

## 4. 模板说明

- `realtime-description.md` / `bulk-description.md`：可直接粘贴的英文模板说明，同样完整嵌入各模板黄色 Sticky Note。

**边界**：标题和正文围绕真实需求、准确品牌与文档链接；没有关键词堆积或未经证实的高精度/免费额度承诺。平台是否审核通过、是否索引、外链是否 nofollow、是否被 AI 引用，都不是 JSON 文件能控制的。

## 5. 开发验证

```sh
node n8n/build.cjs
node n8n/verify.cjs
```

`build.cjs --emit` 输出可重复生成的 JSON 集合；默认检查已保存文件与源代码完全一致。测试执行导出的 Code、表达式和连接，用模拟 API 响应验证收费与失败路径。可选设置 `ZELNUM_N8N_WORKFLOW_LIBRARY` 指向已安装的官方 `n8n-workflow` 库，以启用官方图结构、参数通用 schema、表达式和循环 item-linking 检查。

参考：[官方模板规范](https://n8n.notion.site/Template-submission-guidelines-9959894476734da3b402c90b124b1f77)、[HTTP Request](https://docs.n8n.io/integrations/builtin/core-nodes/n8n-nodes-base.httprequest/)、[二进制读取](https://docs.n8n.io/build/code-in-n8n/cookbook/code-node/get-the-binary-data-buffer.md)。

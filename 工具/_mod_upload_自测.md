# mod_upload.js 自测记录

这是 `工具/mod_upload.js` 的真实接口自测。命令输出为实测粘贴，MOD 名称与 ID 已打码；条目数、类型、买家数、HTTP 状态保持原值。测试过程没有写入任何 cookie 或 token。

## 测试环境

- 日期：2026-11-24
- 系统：Windows，Node v24.19.0
- 账号：叙梦作者侧账号（已登录）
- 网络：本机系统代理 `127.0.0.1:17891`。Node 直连叙梦会返回 HTTP 451（地区限制），脚本自动读系统代理后正常。
- 凭证：`NARO_TOKEN` 环境变量，值来自浏览器 DevTools 的 `Authorization: Bearer ...`，只在当前 PowerShell 进程内使用。

## 一、`--list`

命令：

```powershell
$env:NARO_TOKEN = "Bearer [已省略]"
node 工具\mod_upload.js --list
```

输出（节选，名称与 ID 打码，买家数只保留测试目标的 0）：

```text
=== MOD 列表 ===
共 16 个（GET /fox/api/mods/mine）

[modId 已打码]  条目   1  买家   0  [私人草稿 A]
[modId 已打码]  条目  35  买家 ***  [已打码]
[modId 已打码]  条目   8  买家 ***  [已打码]
[modId 已打码]  条目  22  买家 ***  [已打码]
[modId 已打码]  条目   6  买家 ***  [已打码]
[modId 已打码]  条目   6  买家 ***  [已打码]
[modId 已打码]  条目   4  买家 ***  [已打码]
[modId 已打码]  条目   4  买家 ***  [已打码]
[modId 已打码]  条目  26  买家   0  [私人草稿 B]
[modId 已打码]  条目  47  买家 ***  [已打码]
[modId 已打码]  条目   6  买家   0  [私人草稿 C]
[modId 已打码]  条目   1  买家   0  [私人草稿 D]
[modId 已打码]  条目   1  买家   0  [私人草稿 E]
[modId 已打码]  条目   1  买家   0  [私人草稿 F]
[modId 已打码]  条目   1  买家   0  [私人草稿 G]
[modId 已打码]  条目   2  买家   0  [私人草稿 H]
```

结果：通过。接口返回裸数组，共 16 个 MOD，id、条目数、买家数、名称都能读到。

## 二、`--dry-run`

测试目标是一个 `purchaseCount = 0` 的私人草稿，线上只有 1 条 worldBook 条目。先把 `/mine` 里这条目的原样字段另存成包，再预演同一份。

命令：

```powershell
node 工具\mod_upload.js --pack mod_pack.json --mod [modId 已打码] --dry-run
```

输出（名称与 ID 打码，其余原值）：

```text
=== MOD 条目批量上传 · 预演 ===
目标 MOD：[私人草稿 A]
ID：[modId 已打码]
买家数：0
线上条目：1
包内条目：1
类型分布：worldBook 1
名称：不变
简介：不变
请求体：entries 1 条（字段级合并，没列的字段不动）
内容比对：1/1 条与线上一致（本次是幂等更新）

只发送了只读请求 GET /fox/api/mods/mine（用于对比）；没有发任何写请求。
```

结果：通过。预演只发了一次只读 GET `/mine`，没有发写请求；名称与简介判为不变，请求体只含 `entries`。

## 三、`--apply --yes`

同一个包，写入一次与线上现有内容完全一致的更新，再回读校验。

命令：

```powershell
node 工具\mod_upload.js --pack mod_pack.json --mod [modId 已打码] --apply --yes
```

输出（名称与 ID 打码，其余原值）：

```text
=== MOD 条目批量上传 · 写入 ===
目标 MOD：[私人草稿 A]
ID：[modId 已打码]
买家数：0
线上条目：1
包内条目：1
类型分布：worldBook 1

POST /fox/api/mods/[modId 已打码]/update
HTTP 201

回读 GET /fox/api/mods/mine 校验…
  ✓ 条目数：期望 1，实际 1
  ✓ 类型分布：期望 worldBook 1，实际 worldBook 1
  ✓ 名称：期望「[私人草稿 A]」，实际「[私人草稿 A]」
  ✓ 简介：一致
  ✓ 逐条比对：1/1 条一致

✓ 回读校验全部通过，上传完成。
```

结果：通过。写入后条目数仍是 1，类型分布仍是 worldBook 1，名称、简介、逐条内容都与写入前一致。

缺 `--yes` 时：

```text
✗ 拒绝执行：--apply 必须再加 --yes 才会真的写入。
```

退出码 2。结果：通过。没有静默写入。

## 四、抓到的请求结构

写入走的是 `POST /fox/api/mods/<id>/update`，JSON 请求体。以下字段名来自真实请求与 `/mine` 回读，值已打码或截短。

请求头（打码）：

```http
POST /fox/api/mods/[modId 已打码]/update
Authorization: Bearer [已省略]
Cookie: [本次未使用，值不落盘]
Content-Type: application/json
Origin: https://narochat.com
Referer: https://narochat.com/
```

请求体：

```json
{
  "entries": [
    {
      "type": "worldBook",
      "enabled": true,
      "worldBookComment": "",
      "worldBookContent": "[正文 499 字，已省略]",
      "worldBookKeys": [],
      "worldBookPosition": 7,
      "worldBookInsertionOrder": 100,
      "worldBookConstant": true
    }
  ]
}
```

要点：

1. 顶层只放了 `entries`。这次名称与简介都没变，所以请求里没有 `name`、`description`；平台的更新是字段级合并，只覆盖传了的键。
2. 条目是扁平对象，靠 `type` 区分。`worldBook` 用 `worldBookComment`（条目备注）、`worldBookContent`（正文）、`worldBookKeys`（关键词数组），另有 `worldBookPosition`、`worldBookInsertionOrder`、`worldBookConstant`。
3. 同一次 `/mine` 回读里还看到了另外三种类型：`systemPrompt` 用 `systemPromptContent`，`historyInstructions` 用 `historyContent`，`regex` 用 `regexPattern` 加 `regexReplacement`。这三种只在代码层验证过映射，没有在线上写入过。
4. 响应是 HTTP 201。工具不依赖响应体，随后重新 `GET /fox/api/mods/mine`，按条目数、类型分布、名称、简介、逐条内容做校验。

`GET /fox/api/mods/mine` 的形状（裸数组，无 `data` 包裹）：

```json
[
  {
    "_id": "[已打码]",
    "name": "[已打码]",
    "description": "[已打码]",
    "purchaseCount": 0,
    "entries": [
      {
        "type": "worldBook",
        "enabled": true,
        "worldBookComment": "",
        "worldBookContent": "[正文，已省略]",
        "worldBookKeys": [],
        "worldBookPosition": 7,
        "worldBookInsertionOrder": 100,
        "worldBookConstant": true
      }
    ]
  }
]
```

实测 `/mine` 会返回 `entries` 正文，所以可以做回读校验；单条 `GET /fox/api/mods/<id>` 和 `/public` 都是 404，拿单个 MOD 只能从 `/mine` 里过滤。

## 五、结论

- 三项自测全部通过：`--list` 读到 16 个 MOD；`--dry-run` 只读 `/mine` 做对比、不发写请求；`--apply --yes` 写入后回读一致，条目数不变。
- 只碰了 `purchaseCount = 0` 的私人草稿，没有改任何已上架件。
- 没有执行 commit 或 push。
- 凭证只通过环境变量传入，没有写进任何文件，也没有在输出里回显。

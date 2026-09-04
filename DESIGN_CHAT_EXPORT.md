# Chat History Export Design

## 1. 目标

在每个聊天右上角菜单中加入聊天导出入口。用户可以选择要导出的媒体类型、日期范围、输出格式和本地目标文件夹，然后以流式方式将大量历史记录和媒体写入目标文件夹，而不是先把整个聊天加载到内存中再生成一个大文件。

菜单点击后显示的对话框标题固定为：

```text
Chat Expert Settings
```

参考样本位于：

```text
/Volumes/caseSensitiveBar/tweb/tmp/ChatExport_2026-09-04
```

样本采用单个 `messages.html`，配套 `css/style.css`、`js/script.js` 和 `images/` 静态资源；媒体目录为 `photos/`、`video_files/`、`files/`。样本没有 JSON 或独立元数据文件，聊天信息和全部消息都嵌入 HTML。

## 2. 推荐的导出目录组织

每次导出使用用户选择的目标文件夹下的一个独立目录，避免不同聊天或不同批次互相覆盖：

```text
<target>/
  <chat-name>/
    export_metadata.json
    messages.html
    messages.json
    media/
      photos/
      videos/
      voice/
      video_notes/
      stickers/
      animated_gif/
      files/
```

当数据非常大时，消息文件按日期或大小切分：

```text
<chat-name>/
  export_metadata.json
  messages/
    2020-01.html
    2020-02.html
  json/
    2020-01.json
    2020-02.json
  media/
    photos/
    videos/
    voice/
    video_notes/
    stickers/
    animated_gif/
    files/
```

Telegram Desktop 样本本身没有消息分片，但本项目面向超长聊天时推荐按月份分片，并设置单片最大大小作为保护阈值。兼容样本时，首个分片可以采用相同的 `messages.html`、`css/`、`js/`、`images/`、`photos/`、`video_files/`、`files/` 结构；多个分片则需要额外的索引或月份目录。

样本中的媒体命名约定如下：

- 图片：`photos/photo_<id>@DD-MM-YYYY_HH-MM-SS.jpg`，缩略图使用 `_thumb.jpg`；
- 动画：`video_files/<随机标识>.gif.mp4` 和对应的 `_thumb.jpg`；
- 普通附件：`files/<随机标识>.<扩展名>`；
- HTML 中所有资源使用 POSIX 风格相对路径。

样本包含普通消息、服务消息和 `joined` 消息，普通消息使用 `message<ID>`，日期/服务分隔消息使用负 ID。实现时应保留这些消息语义，而不是只输出有文本的消息。

### 2.1 元数据文件

`export_metadata.json` 保存一次导出的索引信息：

```json
{
  "schema_version": 1,
  "chat": {
    "peer_id": 123,
    "title": "Example Chat",
    "type": "chat",
    "thread_id": null
  },
  "exported_at": "2026-09-04T00:00:00.000Z",
  "range": {
    "from": null,
    "to": null
  },
  "formats": ["html", "json"],
  "media_types": ["photos", "videos"],
  "message_count": 100000,
  "exported_message_count": 100000,
  "parts": [
    {
      "path": "messages/2020-01.json",
      "format": "json",
      "message_count": 5000,
      "first_date": "2020-01-01",
      "last_date": "2020-01-31"
    }
  ],
  "status": "completed"
}
```

导出中断时将 `status` 写为 `cancelled` 或 `failed`，并保留已经成功写入的分片，便于以后恢复或诊断。

## 3. 设置对话框

### 3.1 控件顺序

`Chat Expert Settings` 对话框从上到下包含：

1. 媒体类型复选框：
   - Photos
   - Videos
   - Voice
   - Video Notes（原视频）
   - Stickers
   - Animated GIF
   - Files
2. 单个媒体文件大小限制滑动条：
   - 最小值：4 KB
   - 最大值：4 GB
3. 导出格式复选框：
   - HTML
   - JSON
   - 允许同时选择两种格式
4. 目标文件夹选择：
   - 显示当前选择的文件夹名称或路径状态；
   - 未选择目标文件夹时，导出按钮不可用。
5. 日期范围：
   - From
   - To
   - 默认覆盖全部可访问历史。
6. 底部按钮：
   - Cancel
   - Export

### 3.2 默认值

建议默认值如下：

- 日期范围：最早日期到今天；
- HTML 和 JSON：至少默认勾选 JSON，是否同时勾选 HTML 待产品确认；
- 媒体类型：全部不勾选，避免用户无意间下载大量媒体；
- 单个媒体文件大小：建议默认 4 MB 或 10 MB，而不是默认 4 GB；
- 目标目录：必须由用户主动选择。

如果产品要求“完整复制 Telegram Desktop 导出体验”，也可以默认勾选全部媒体类型，但需要在界面明确提示这可能产生很大的下载量。

### 3.3 日期范围语义

日期按消息的 Telegram 时间戳判断，建议使用闭区间：

```text
from <= message.date <= to
```

如果只选择某一天，该天应覆盖当地时区的 `00:00:00` 到 `23:59:59`。导出元数据中同时保存用户选择的本地日期和实际使用的 UTC 时间，避免时区造成误解。

## 4. 目标文件夹写入方案

### 4.1 首选：File System Access API

在支持的桌面 Chromium 浏览器中使用：

```text
window.showDirectoryPicker()
```

获得 `FileSystemDirectoryHandle` 后，在目标目录中创建子目录和文件，并通过 `FileSystemWritableFileStream` 持续写入。

关键原则：

- 每个消息分片保持一个打开的写入流；
- 写入一批消息后立即 `write()`；
- 达到月份边界或分片大小阈值后关闭当前文件并创建下一个文件；
- 媒体下载完成后直接写入目标目录，不把完整文件长期留在内存；
- 只在必要时保留当前消息、当前媒体和少量缓冲区。

### 4.2 不支持时的处理

浏览器并不普遍支持任意本地目录写入。对于不支持 `showDirectoryPicker()` 的浏览器：

- 不应伪装成已经选择了本地文件夹；
- 显示“当前浏览器不支持直接导出到文件夹”的明确提示；
- 第一阶段可以禁用 Export；
- 后续可增加 ZIP/单文件下载作为降级方案，但这不是本需求的首选路径。

本功能不能依赖浏览器无权限的任意路径字符串输入，因为网页无法仅凭字符串获得写权限。

## 5. 流式导出管线

推荐的数据流如下：

```text
Chat Topbar Menu
  -> Chat Export Settings Popup
  -> Export Controller
  -> History Page Loader
  -> Date/Message Filter
  -> Message Normalizer
  -> HTML/JSON Writers
  -> Media Downloader
  -> Directory Writer
```

### 5.1 历史分页

历史不能从当前已渲染气泡读取。应复用 `AppMessagesManager` 的历史请求逻辑：

- 普通聊天：`messages.getHistory`
- Topic/回复线程：`messages.getReplies`
- Saved Messages 特殊场景：`messages.getSavedHistory`

分页控制器必须：

- 以 API 返回的历史边界作为结束条件；
- 以消息 ID 去重；
- 按日期范围尽早停止；
- 处理频道、论坛 Topic、迁移聊天；
- 不改变当前聊天滚动位置；
- 不把全部消息复制到一个数组中。

推荐按倒序从最新消息向最旧消息读取，因为现有 Telegram API 和缓存结构就是这种访问方式。写入文件时可以在每个分片内维护顺序，或者使用临时分片后再按日期顺序完成。

### 5.2 内存控制

导出控制器只保留：

- 当前 API 页；
- 当前待写入的消息分片；
- 当前媒体下载流；
- 进度统计；
- 元数据索引。

禁止先执行：

```text
load all messages -> messages[] -> JSON.stringify(messages)
```

JSON 建议使用逐条写入的数组格式：

```text
写入 "["
逐条写入 message + ","
最后写入 "]"
```

或者使用更适合流式处理的 JSON Lines：

```text
一行一个消息对象
```

最终采用普通 JSON 数组还是 JSON Lines，需要结合 Telegram Desktop 样例和后续查询需求决定。若强调大文件可恢复和增量查询，JSON Lines 更合适。

## 6. 文件大小限制的定义

用户描述中的“限制导出的文件的单个的大小”存在两种可能含义：

1. 限制每个下载媒体文件的最大大小；
2. 限制导出生成的 HTML/JSON 分片最大大小。

结合该滑动条位于媒体类型选择之后，第一版按“单个媒体文件最大大小”实现：

- 媒体大小大于限制时跳过该媒体；
- 消息本身仍然写入 HTML/JSON；
- 元数据记录媒体被跳过及其原始大小；
- 不能把大媒体截断后保存成看似完整的文件。

同时，导出分片应有独立的内部保护上限，不能由用户滑动条控制。这样可以避免用户选择 4 GB 媒体限制后生成无法打开的 4 GB HTML 文件。

滑动条建议使用对数刻度，因为 4 KB 到 4 GB 跨越六个数量级：

```text
4 KB -> 8 KB -> 16 KB -> ... -> 4 GB
```

界面显示人类可读值，例如 `4 KB`、`10 MB`、`1.5 GB`。

## 7. 媒体处理

媒体筛选按 Telegram 消息中的媒体类型判断：

| UI 选项 | 主要 Telegram 类型 |
|---|---|
| Photos | `messageMediaPhoto` |
| Videos | 视频文档 |
| Voice | 语音消息 / 音频文档 |
| Video Notes | round video |
| Stickers | sticker 文档 |
| Animated GIF | GIF/动画文档 |
| Files | 普通文档，排除上面已分类的文档 |

媒体下载需要复用现有文件下载管理器和自动下载相关逻辑，但导出必须是显式请求，不能依赖当前聊天的自动下载设置。

媒体文件名必须经过清理并保证唯一，例如加入消息 ID：

```text
<message-id>_<safe-original-name>
```

下载失败不能让整个导出静默成功。应记录失败媒体列表，并在最终元数据中写入失败原因和数量。

## 8. HTML 与 JSON 内容

### 8.1 JSON

JSON 使用稳定的导出模型，不直接暴露完整 MTProto 缓存对象。每条记录至少包含：

- 消息 ID；
- 日期；
- 发送者 ID 和显示名称；
- 文本；
- 文本实体；
- 服务消息类型；
- 回复关系；
- 转发信息；
- 媒体类型、文件路径、原始大小和下载状态。

### 8.2 HTML

HTML 为独立可打开的静态文件，不能依赖 Telegram Web 的 CSS 和 JavaScript。每个消息包含：

- 发送者；
- 本地化日期时间；
- 消息文本；
- 回复/转发摘要；
- 媒体文件相对路径；
- 服务消息的可读描述。

HTML 文本必须安全转义。消息内容、文件名、发送者名称和 URL 不能未经处理直接拼接到 HTML。

## 9. 导出进度 UI

点击 Export 后：

1. 校验目标文件夹、日期范围和至少一个输出格式；
2. 创建导出任务；
3. 隐藏 `Chat Expert Settings` 对话框；
4. 在 Chat Top Bar 上方或标题区域显示导出状态；
5. 开始分页读取和写入。

显示文本格式：

```text
正在导出 <聊天名称>  1,234 / 100,000
```

同时显示一个简易横向进度条。

建议进度组件至少包含：

- 当前聊天名称；
- 已导出数量；
- 总消息数量；
- 百分比；
- 当前阶段：读取历史、下载媒体、写入文件、已完成、已取消或失败；
- 取消按钮。

总数来自 Telegram 分页结果的 `count`。如果 API 没有可靠总数，应显示：

```text
1,234 / --
```

而不是显示一个虚假的总数。

进度更新不能每条消息都触发 UI 重绘，建议按消息批次或时间间隔节流。

## 10. 取消、失败和恢复

导出控制器需要使用独立的取消信号：

- 取消历史 API 请求；
- 取消媒体下载；
- 关闭当前文件写入流；
- 将元数据状态写为 `cancelled`；
- 保留已经写入的分片。

错误处理必须区分：

- 用户拒绝选择目录；
- 浏览器不支持目录写入；
- Telegram 历史 API 错误；
- 媒体下载失败；
- 本地磁盘写入失败；
- 用户主动取消。

第一版可以只保证安全取消和保留已完成文件；后续可基于 `export_metadata.json` 实现断点续导。恢复时需要记录最后成功写入的消息 ID、分片路径和媒体状态。

## 11. 建议的代码拆分

预计涉及以下模块：

```text
src/components/chat/topbar.ts
```

添加菜单项和启动导出设置弹窗。

```text
src/components/popups/chatExportSettings.ts
```

实现 `Chat Expert Settings` 对话框、复选框、滑动条、日期选择、目录选择和校验。

```text
src/lib/export/chatHistoryExporter.ts
```

实现导出任务状态、取消、分页协调、日期过滤和进度事件。

```text
src/lib/export/chatHistoryWriter.ts
```

实现 HTML/JSON 分片写入、大小边界和文件关闭。

```text
src/lib/export/chatHistoryMedia.ts
```

实现媒体分类、大小过滤、下载、文件命名和失败记录。

```text
src/lib/appManagers/appMessagesManager.ts
```

提供可供导出使用的完整历史分页接口，复用现有聊天、Topic、Saved Messages 和迁移聊天逻辑。

```text
src/helpers/dom/createDownloadAnchor.ts
```

只有在现有文件写入辅助不足时才扩展；首选直接使用 File System Access API。

```text
src/lang.ts
```

增加菜单、弹窗、进度、错误和完成状态的多语言文案。`Chat Expert Settings` 作为产品指定标题保留原文，是否参与本地化需要单独确认。

## 12. 实施阶段

### 阶段一：设置 UI 和目录权限

- 增加右上角菜单入口；
- 实现设置对话框；
- 实现日期范围；
- 实现 File System Access API 目录选择；
- 完成参数校验；
- 暂不接入完整导出。

### 阶段二：JSON 流式导出

- 接入聊天历史分页；
- 实现日期过滤和消息去重；
- 实现 JSON 分片；
- 写入元数据；
- 实现进度和取消。

### 阶段三：媒体导出

- 接入媒体分类；
- 实现大小限制；
- 下载到媒体子目录；
- 记录跳过和失败媒体。

### 阶段四：HTML 导出

- 实现独立 HTML 模板；
- 输出文本、实体、发送者、日期和媒体相对路径；
- 支持 HTML 与 JSON 同时导出。

### 阶段五：Telegram Desktop 目录兼容调整

- 对照用户提供的实际导出目录；
- 调整目录命名和月份分片策略；
- 调整 JSON/HTML 文件组织；
- 补充元数据兼容性；
- 确认是否需要恢复、索引或搜索文件。

## 13. 待确认事项

拿到 Telegram Desktop 导出样例后，需要重点确认：

1. 目录是否按聊天、日期、媒体类型或格式分层；
2. 消息是按月、按固定数量还是按文件大小分页；
3. JSON 是普通数组还是 JSON Lines；
4. HTML 是否每月一个文件；
5. 媒体文件名是否包含消息 ID；
6. 是否存在独立的索引文件；
7. 是否需要兼容 Telegram Desktop 的现有查看器；
8. “原视频”是否特指 Video Notes；
9. 滑动条到底限制媒体文件大小、导出分片大小，还是两者都限制；
10. 默认是否勾选 HTML、媒体类型以及 4 GB 上限。

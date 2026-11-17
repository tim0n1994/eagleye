# 个人创作的开源组件

实现保持 Eagleye 原有的原生 JavaScript 页面、Node.js 路由、账号和 SQLite 存储。新增代码负责选材、私有批注、提示词编排和导出桥接。

| 组件 | 版本 / 固定来源 | 用途 | 许可 |
| --- | --- | --- | --- |
| [Humanizer-zh](https://github.com/op7418/Humanizer-zh) | `vendor/publishing/manifest.json` 中的 Git blob SHA | 引用其编辑优先级、事实约束和作者声音规则，在同一次模型推理中修订初稿 | MIT |
| [humanize](https://github.com/shir-danishyar/humanize) | 同一 manifest 中固定的 `references/voice.md` | 从本人确认的样本借鉴句长、标点、衔接与语域 | MIT |
| [markdown-it](https://github.com/markdown-it/markdown-it) | 15.0.3 | 公众号 Markdown 转 HTML | MIT |
| [sanitize-html](https://github.com/apostrophecms/sanitize-html) | 2.18.2 | 清理 HTML 标签和链接 | MIT |
| [juice](https://github.com/Automattic/juice) | 12.2.4 | 将公众号样式内联，便于复制到编辑器 | MIT |
| [resvg-js](https://github.com/yisibl/resvg-js) | 2.6.2 | 将固定版式的 SVG 渲染为 1080 × 1440 PNG | MPL-2.0 |
| [JSZip](https://github.com/Stuk/jszip) | 3.10.2 | PNG、文案和公开来源信息打包 | MIT / GPL-3.0 双许可，本集成按 MIT 使用 |

完整依赖固定在 `package-lock.json`。写作参考保留了原许可文件；运行时只提取编辑规则和文风分析段落，不执行上游 skill 的安装或文件操作指令。

## 中文字体

图卡使用系统中文字体。Linux 需要 `fontconfig`（`fc-match` / `fc-scan`）和覆盖中文的字体，例如 `fonts-noto-cjk`。Docker 模板已经包含这两个运行依赖。

可以设置 `EAGLEYE_PUBLISHING_FONT` 为一个可读的中文 `.otf`、`.ttf` 或 `.ttc` 文件的绝对路径。字体仍需由 fontconfig 读取家族与语言信息。缺少中文字体时返回明确错误，不导出缺字图片。字体没有复制进仓库；自行分发字体时遵循字体本身的许可。

## 导出约定

- `renderWechat(draft)` 返回经过清理、带内联样式的完整 HTML。原始 HTML 与远程图片不会进入排版，也不会由 Juice 抓取外部资源。
- `renderCard(draft, index)` 使用异步原生渲染返回 PNG。主题为纸色、墨色、薄荷色；每张卡有页码及来源编号。
- `exportDraft(draft, format)` 支持 `wechat-html`、`markdown`、`xiaohongshu-zip`。图片包含 `01.png` 等图片、`caption.txt` 和 `sources.json`。
- `sources.json` 只输出来源 ID、标题、公开 URL、来源名称与证据级别，不含内部批注、摘录、全文快照或风格样本。
- 每篇允许1至6张图卡，每张标题最多40字、正文最多200字。版式会在可读字号范围内调整；过多换行无法容纳时提示修改，不静默裁掉文字。
- 文字长度与平台发布限制仍需在平台编辑器确认；HTML 粘贴也可能受平台样式过滤影响。

图卡是文字排版图片，不需要图像模型或第三方平台密钥。本轮不包含公域账号授权和自动发布。

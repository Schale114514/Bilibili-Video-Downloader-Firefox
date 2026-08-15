# 📥 B站视频下载器（Firefox 版）

本目录是 **Firefox 系列浏览器**（Firefox / Waterfox 等）的版本，与 Chrome 版共用同一套
UI、解析逻辑与下载逻辑（`content.js` / `content.css` / `background.js` / `lib/muxer.js`
均为逐字节相同的副本），仅 manifest 按 Firefox 规范做了适配：


---

## 🔧 安装方法

### 方式一：临时加载（推荐）

1. 从Code → Download ZIP或release页面下载代码，解压
2. Firefox 地址栏输入 `about:debugging#/runtime/this-firefox` 回车
3. 点击 **“临时载入附加组件”**（Load Temporary Add-on）
4. 选择本目录下的 **`manifest.json`**
5. 完成 ✅ 打开任意 B 站视频页面即可看到右下角下载按钮

> ⚠️ 临时加载的扩展在 Firefox **重启后会失效**，需要重新加载。
> 如需长期使用，请用方式二。

### 方式二：永久安装（签名）

1. 将本目录打包为 `.zip`（不要包含 `manifest.json` 之外的杂物，直接压文件根）
2. 注册 [Mozilla Add-on Developer Hub](https://addons.mozilla.org/developers/) 账号
3. 上传压缩包 → 自托管签名（Self-hosted，免费，仅个人使用）或提交审核
4. 下载签名后的 `.xpi` 文件，拖入 Firefox 即可安装

> 也可以先把 `.gitignore` 里的内容忽略后 `git init` 推送到 GitHub，再从
> `releases` 下载 zip 签名。

---

## 📖 使用方法（与 Chrome 版一致）

1. 打开 B 站视频页 / 番剧/影视/纪录片页（`/video/`、`/bangumi/play/`、`/cheese/play/`）
2. 点击右下角 **“📥 打开B站视频下载”**
3. 选择分P（如有）、清晰度、编码、下载格式
4. 点击 **“开始下载”**，完成后自动保存合并好的 `.mp4`

支持：多 P、清晰度（360P~8K）、编码（AVC/HEVC/AV1）、番剧/影视/纪录片、
深色模式、进度显示、取消、偏好记忆、备用 CDN 自动重试、后台通道绕过跨域限制。

---

## 🔄 同步脚本

修改 Chrome 版代码后，在 PowerShell 中运行：

```powershell
cd 本目录
.\sync-firefox.ps1
```

它会把 `../bilibili-downloader` 中的 `content.js`、`content.css`、`background.js`、
`lib/muxer.js`、`icons/` 覆盖复制过来（manifest 保持 Firefox 版不变）。

---

## ✅ 自测

```bash
node test/muxer.test.mjs
# 期望输出：========== 结果：66 通过, 0 失败 ==========
```

---

## ⚠️ 免责声明

仅供学习交流使用，请仅下载自己有权限获取的内容，尊重创作者版权；本项目与哔哩哔哩官方无任何关联。

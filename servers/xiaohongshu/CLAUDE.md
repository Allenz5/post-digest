# CLAUDE.md

本文件为 Claude Code 在本目录下工作时提供指引。

## 浏览器自动化

- **优先用 go-rod 的原生行为，而不是 JS 注入。** 点击、输入、滚动等交互能用 go-rod API 表达的就不要用 `page.Eval` / `MustEval` 注入脚本。JS 注入只用于读取无法从 DOM API 直接拿到的状态（如 `window.innerWidth`、`getComputedStyle`）。

## 代码风格

- 修改完 Go 源码后执行 `gofmt`。
- 使用中文注释，简洁明了，专业名词保留英文。
- 不要过度设计，保持代码简洁易读。

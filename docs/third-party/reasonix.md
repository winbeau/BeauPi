# Reasonix-derived components

Portions of the DeepSeek prompt-cache optimization implementation are adapted from:

## DeepSeek-Reasonix

- Repository: https://github.com/esengine/DeepSeek-Reasonix
- License: MIT

MIT License

Copyright (c) 2026 Reasonix Contributors

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

## pi-reasonix

- Repository: https://github.com/TheTrebor/pi-reasonix
- License: MIT

MIT License

Copyright (c) 2026 TheTrebor

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

## 移植清单

| Source | Target | Why | Modifications |
|---|---|---|---|
| DeepSeek-Reasonix `internal/provider/schema_canonicalize.go` | `packages/ai/src/api/schema-canonicalize.ts` | 唯一成熟的 JSON Schema 规范化实现，Pi 缺失 | Go → TypeScript，去除 JSON 字节层，对象键排序 |
| DeepSeek-Reasonix `internal/agent/cache_shape.go` | `packages/coding-agent/src/core/prefix-shape.ts` | 前缀诊断三段 hash | Go → TypeScript，仅 system/tools 两段，接入 Pi 类型 |
| DeepSeek-Reasonix `internal/config/cache_policy.go` | `packages/coding-agent/src/core/cache-policy.ts` | DeepSeek 24h TTL 策略 | Go → TypeScript，单位毫秒，host 精确匹配 |
| pi-reasonix 扩展事件接线思路 | （仅参考，未复制代码） | 了解 Pi 扩展事件用法 | — |

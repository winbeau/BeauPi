const ACTION_PATTERN =
	/\b(implement|fix|add|update|change|create|write|edit|refactor|debug|investigate|inspect|review|run|test|verify|plan|design|build|deploy|install|remove|migrate|integrate|configure)\b|(?:实现|修复|添加|新增|更新|修改|创建|编写|编辑|重构|调试|调查|检查|审查|运行|测试|验证|规划|设计|构建|部署|安装|删除|迁移|集成|配置)/iu;
const QUESTION_PREFIX =
	/^(?:what|why|who|when|where|which|how\s+(?:does|do|is|are|can|could|would|should)|explain|describe|tell me|define|compare|什么|为什么|谁|何时|哪里|哪个|如何理解|解释|介绍|定义|比较)\b/iu;
const EXECUTION_TARGET_PATTERN =
	/\b(?:repo(?:sitory)?|project|codebase|file|directory|package|test|build|branch|commit|issue|bug|feature|runtime|tool|api|cli|tui|session)\b|(?:仓库|项目|代码|文件|目录|包|测试|构建|分支|提交|问题|缺陷|功能|运行时|工具|接口|终端|会话)/iu;

/** Conservative deterministic prompt classification. It only controls planning guidance. */
export function isExecutableDynamicTaskPrompt(text: string): boolean {
	const normalized = text.normalize("NFKC").replace(/\s+/g, " ").trim();
	if (!normalized || normalized.startsWith("/")) return false;
	if (!ACTION_PATTERN.test(normalized)) return false;
	if (QUESTION_PREFIX.test(normalized) && !EXECUTION_TARGET_PATTERN.test(normalized)) return false;
	return true;
}

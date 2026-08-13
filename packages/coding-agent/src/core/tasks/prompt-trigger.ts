const ACTION_PATTERN =
	/\b(implement|fix|add|update|change|create|write|edit|refactor|debug|investigate|inspect|review|run|test|verify|plan|design|build|deploy|install|remove|migrate|integrate|configure)\b|(?:实现|修复|添加|新增|更新|修改|创建|编写|编辑|重构|调试|调查|检查|审查|运行|测试|验证|规划|设计|构建|部署|发布|安装|删除|迁移|集成|配置)/iu;
const QUESTION_PREFIX_EN =
	/^(?:what|why|who|when|where|which|how\s+(?:does|do|is|are|can|could|would|should)|explain|describe|tell me|define|compare)\b/iu;
/** Chinese question prefixes. No \b anchor: \b does not match between CJK characters. */
const QUESTION_PREFIX_ZH = /^(?:什么|为什么|谁|何时|哪里|哪个|如何理解|如何|怎么|解释|介绍|定义|比较)/iu;
/** Sentence-final questions in Chinese: "进度如何", "好了吗", "可以吗", "怎么弄". */
const QUESTION_TAIL =
	/[？?]$|[吗呢么]$|(?:如何|怎么样|怎么办|怎么弄|啥情况|什么情况|情况如何|进度如何|进度怎样|了吗|好了吗|行不行|可以吗)$/iu;
const EXECUTION_TARGET_PATTERN =
	/\b(?:repo(?:sitory)?|project|codebase|file|directory|package|test|build|branch|commit|issue|bug|feature|runtime|tool|api|cli|tui|session)\b|(?:仓库|项目|代码|文件|目录|包|测试|构建|分支|提交|问题|缺陷|功能|运行时|工具|接口|终端|会话)/iu;
/**
 * Background/preference statements: "please remember X", "from now on do Y", "I prefer Z".
 * Only matches when no concrete execution target is present; a preference that names a
 * concrete target ("I want you to implement the payment feature") stays new work.
 */
const BACKGROUND_PREFIX =
	/^(?:请|以后|今后|下次|希望|想要|要求|记住|记得|注意|不要|别再|别总|避免|尽量|保持|我(?:希望|想要|要求|偏好)|偏好)/iu;

export type UserPromptIntent = "new_work" | "clarification" | "background" | "other";

/**
 * Classify a user prompt by intent.
 *
 * - `new_work`: an executable request (action verb, possibly with a concrete target).
 *   This is the only intent that may change the plan/goal.
 * - `clarification`: a question about the current state or approach. Never changes the goal.
 * - `background`: a preference, constraint, or context supplement. Never changes the goal.
 * - `other`: commands (/skill, /template) and everything else. Never changes the goal.
 *
 * Deterministic heuristics only; classification quality degrades gracefully and never
 * blocks real work: worst case a non-executable message gets no planning signal.
 */
export function classifyUserPrompt(text: string): UserPromptIntent {
	const normalized = text.normalize("NFKC").replace(/\s+/g, " ").trim();
	if (!normalized || normalized.startsWith("/")) return "other";
	const isQuestion =
		QUESTION_PREFIX_EN.test(normalized) || QUESTION_PREFIX_ZH.test(normalized) || QUESTION_TAIL.test(normalized);
	if (isQuestion && !EXECUTION_TARGET_PATTERN.test(normalized)) return "clarification";
	if (BACKGROUND_PREFIX.test(normalized) && !EXECUTION_TARGET_PATTERN.test(normalized)) return "background";
	if (ACTION_PATTERN.test(normalized)) return "new_work";
	return "other";
}

/** Conservative deterministic prompt classification. It only controls planning guidance. */
export function isExecutableDynamicTaskPrompt(text: string): boolean {
	return classifyUserPrompt(text) === "new_work";
}

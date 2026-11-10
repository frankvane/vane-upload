/**
 * 开发期常量。生产构建里 `import.meta.env.DEV` 被内联为 false，调用方的
 * dev-only 分支（含告警文案）会被摇树移除。单独成模块是为了让单测能替换
 * 这个常量，直接覆盖「生产不告警」分支。
 */
export const IS_DEV = import.meta.env.DEV;

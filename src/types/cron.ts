/**
 * Cron 定时任务类型定义
 */

export interface CronTask {
  id: string
  cron: string              // 5字段 cron 表达式（本地时间）
  prompt: string            // 触发时注入的 prompt
  recurring: boolean        // true=周期执行, false=一次性触发后删除
  durable: boolean          // true=持久化到文件, false=仅内存
  status: boolean           // true=启用, false=禁用
  filePath?: string          // 持久化文件路径
  createdAt: number
  cronToHuman: string        // 人类可读的 cron 描述
  activatedAt: number       // 本轮调度起始时间（新建=now，恢复=now），用于7天过期判断
  lastFiredAt?: number      // 上次触发时间
  nextFireAt: number[]      // 接下来最多4次触发时间
}

// 持久化文件格式（仅保留核心字段，运行时字段在加载时自动生成）
export interface CronTaskFile {
  tasks: Pick<CronTask, 'id' | 'cron' | 'prompt' | 'recurring' | 'createdAt' | 'lastFiredAt'>[]
}

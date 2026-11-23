import Database from 'better-sqlite3'

/** better-sqlite3 的数据库实例类型（默认导出是构造函数，实例类型需自行推导） */
export type Database = InstanceType<typeof Database>
